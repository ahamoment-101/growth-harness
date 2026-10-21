import type { RuntimeAgentEnv } from '../agent-runtime/env';
import type { RuntimeExecutionContext } from '../agent-runtime/execution-context';
import { createRuntimeExecution, currentExecution, dispatchExecution } from '../agent-runtime/runtime-executions';
import { startRuntimeRun } from '../agent-runtime/run-service';
import { taskForRun } from '../agent-runtime/task-store';
import { readRuntimeJson } from '../agent-runtime/runtime-content';
import { publicWorkText } from '../agent-runtime/work-progress';
import { readLeaderHitlHistory } from './hitl-history';
import type { Message } from '@earendil-works/pi-ai';
import type { LeaderConversation, LeaderDetail, LeaderMessage, LeaderTask } from '../../shared/growth-leader';
import { titledTasks } from '../team-status/panel';
import { pendingWork } from '../agent-work';
import { agentDefinition, type AgentId } from '../agent-runtime/definitions';
import { dispatchPendingAgentEvents, pendingEventDeliveries, publicationConversationId } from '../agent-events/pool';

export type LeaderScope = { workspaceId: string; siteId: string };
export async function getConversation(env: RuntimeAgentEnv, scope: LeaderScope, id: string) {
  return env.DB.prepare(`select ${conversationColumns} from leader_conversations c
    left join agent_tasks t on t.active_run_id=c.id
    left join agent_runtime_executions e on e.id=t.execution_id where c.id=? and c.workspace_id=? and c.site_id=?`)
    .bind(id, scope.workspaceId, scope.siteId).first<LeaderConversation>();
}
const conversationColumns = `c.*,coalesce(t.status,'ready') status,coalesce(t.reason,'') reason,
    coalesce(e.status,'') execution_state,coalesce(e.retry_at,'') next_recovery_at,
    max(c.created_at,coalesce(t.updated_at,''),coalesce((select max(i.created_at) from leader_inputs i where i.conversation_id=c.id),'')) updated_at,
    coalesce((select substr(i.content,1,160) from leader_inputs i where i.conversation_id=c.id and i.kind in ('user','assignment') order by i.position limit 1),'') preview,
    (select count(*) from agent_tasks ch where t.id is not null and ch.parent_task_id=t.id and ch.status not in ('completed','cancelled','failed')) team_active,
    (select count(*) from agent_tasks ch where t.id is not null and ch.parent_task_id=t.id and ch.status='completed' and ch.outcome not in ('unable_to_complete','cancelled')) team_delivered,
    (select count(*) from agent_tasks ch where t.id is not null and ch.parent_task_id=t.id) team_total,
    (select count(*) from leader_inputs i where i.conversation_id=c.id and i.read_at is null) pending_inputs`;
export async function listConversations(env: RuntimeAgentEnv, scope: LeaderScope) {
  return (await env.DB.prepare(`select ${conversationColumns} from leader_conversations c
    left join agent_tasks t on t.active_run_id=c.id
    left join agent_runtime_executions e on e.id=t.execution_id where c.workspace_id=? and c.site_id=? order by updated_at desc,c.id desc`)
    .bind(scope.workspaceId, scope.siteId).all<LeaderConversation>()).results;
}
export async function createConversation(env: RuntimeAgentEnv, scope: LeaderScope, input: { id: string; title: string; context?: string; sourceId?: string }) {
  if (input.sourceId && !await getConversation(env, scope, input.sourceId)) throw new Error('Source conversation not found');
  await env.DB.prepare(`insert or ignore into leader_conversations(id,workspace_id,site_id,title,context,source_id,created_at)
    select ?,?,?,?,?,?,? where exists(select 1 from sites where id=? and workspace_id=?)`)
    .bind(input.id, scope.workspaceId, scope.siteId, input.title, input.context || '', input.sourceId || '', new Date().toISOString(), scope.siteId, scope.workspaceId).run();
  const saved = await getConversation(env, scope, input.id);
  if (!saved || saved.title !== input.title || saved.context !== (input.context || '') || saved.source_id !== (input.sourceId || '')) throw new Error('Conversation identity conflicts with existing request');
  return saved;
}
/** Accept the first user message and its conversation together. D1 batch is transactional.
 * A replay must match the original scope and payload. NOT NULL guards abort the entire
 * batch on identity conflicts, including a message ID already owned by another conversation.
 * Internal scheduled/delegated conversations continue to use createConversation.
 */
export async function startConversation(env: RuntimeAgentEnv, scope: LeaderScope,
  input: { id: string; title: string; context?: string; message: { id: string; text: string } }, actorId: string) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`insert into leader_conversations(id,workspace_id,site_id,title,context,source_id,created_at)
      values(?,?,?,case when exists(select 1 from sites where id=? and workspace_id=?) then ? else null end,?,'',?)
      on conflict(id) do update set title=case when
        leader_conversations.workspace_id=excluded.workspace_id and leader_conversations.site_id=excluded.site_id
        and leader_conversations.title=excluded.title and leader_conversations.context=excluded.context
        and leader_conversations.source_id=''
        and exists(select 1 from leader_inputs where id=? and conversation_id=excluded.id
          and kind='user' and actor_id=? and content=?)
        then leader_conversations.title else null end`)
      .bind(input.id, scope.workspaceId, scope.siteId, scope.siteId, scope.workspaceId, input.title, input.context || '', now,
        input.message.id, actorId, input.message.text),
    env.DB.prepare(`insert into leader_inputs(id,conversation_id,kind,actor_id,content,created_at) values(?,?,'user',?,?,?)
      on conflict(id) do update set content=case when
        leader_inputs.conversation_id=excluded.conversation_id and leader_inputs.kind=excluded.kind
        and leader_inputs.actor_id=excluded.actor_id and leader_inputs.content=excluded.content
        then leader_inputs.content else null end`)
      .bind(input.message.id, input.id, actorId, input.message.text, now),
  ]);
}

export async function enqueueInput(env: RuntimeAgentEnv, scope: LeaderScope, conversationId: string, input: { id: string; kind: 'user' | 'child_report' | 'assignment'; actorId: string; content: string }) {
  if (!await getConversation(env, scope, conversationId)) throw new Error('Conversation not found');
  const task = await taskForRun(env.DB, conversationId);
  if (task && ['completed','cancelled','failed'].includes(task.status)) throw new Error('Conversation is closed');
  await env.DB.prepare('insert or ignore into leader_inputs(id,conversation_id,kind,actor_id,content,created_at) values(?,?,?,?,?,?)')
    .bind(input.id, conversationId, input.kind, input.actorId, input.content, new Date().toISOString()).run();
  const saved = await env.DB.prepare('select * from leader_inputs where id=?').bind(input.id).first<{conversation_id:string;kind:string;actor_id:string;content:string}>();
  if (!saved || saved.conversation_id !== conversationId || saved.kind !== input.kind || saved.actor_id !== input.actorId || saved.content !== input.content) throw new Error('Message identity conflicts with existing request');
}
export async function pendingInputs(env: RuntimeAgentEnv, conversationId: string) {
  // read_at is set by a trigger when the Leader's transcript records the input (migration 0070).
  return (await env.DB.prepare(`select i.* from leader_inputs i where conversation_id=? and read_at is null order by i.position`)
    .bind(conversationId).all<{id:string;kind:string;actor_id:string;content:string;created_at:string}>()).results;
}
/** Called by the controller, never by a child using its execution credential. */
export async function wakeConversation(env: RuntimeAgentEnv, scope: LeaderScope, id: string, scheduledKey?: string) {
  const task = await taskForRun(env.DB, id);
  const [inputs, events] = await Promise.all([
    pendingInputs(env, id),
    task?.definition_version && task.definition_version < 3 || (!task && id !== publicationConversationId(scope.siteId))
      ? Promise.resolve([])
      : pendingEventDeliveries(env.DB, { ...scope, agentId: 'growth_leader' }, id, 1),
  ]);
  if (!inputs.length && !events.length) return;
  const conversation = await getConversation(env, scope, id);
  if (!conversation) return;
  if (!task) {
    await startRuntimeRun(env, { ...scope, agentId: 'growth_leader', instanceId: id, runId: id,
      trigger: scheduledKey ? 'cron' : 'manual', ...(scheduledKey ? { scheduleKey: scheduledKey } : {}),
      summary: { title: conversation.title, context: conversation.context } });
    return;
  }
  const previous = await currentExecution(env.DB, id);
  if (task.status === 'running') {
    if (previous?.status === 'dispatching') await dispatchExecution(env, previous);
    return;
  }
  if (task.status !== 'waiting' || task.outcome !== 'leader_ready') return;
  // Projection must be settled before a new execution can claim this conversation.
  if (previous?.status !== 'waiting') return;
  try { await dispatchExecution(env, await createRuntimeExecution(env.DB, id, previous, 'conversation_input')); }
  catch (error) { const winner = await currentExecution(env.DB, id); if (!winner || winner.id === previous.id) throw error; await dispatchExecution(env, winner); }
}
export async function settleLeaderCheckpoint(env: RuntimeAgentEnv, authority: RuntimeExecutionContext) {
  const task = await taskForRun(env.DB, authority.runId);
  if (!task || task.execution_id !== authority.executionId || task.epoch !== authority.epoch || task.status !== 'waiting' || task.outcome !== 'leader_ready') return null;
  await env.DB.batch([
    env.DB.prepare(`update agent_runs set status='waiting_for_input',phase='conversation_ready',execution_outcome='leader_ready',finished_at='' where id=?
      and exists(select 1 from agent_tasks where id=? and execution_id=? and status='waiting')`).bind(authority.runId, task.id, authority.executionId),
    env.DB.prepare(`update agent_runtime_executions set status='waiting',updated_at=? where id=? and exists(select 1 from agent_tasks where id=? and execution_id=? and status='waiting')`)
      .bind(new Date().toISOString(), authority.executionId, task.id, authority.executionId),
  ]);
  const scope = { workspaceId: task.workspace_id, siteId: task.site_id };
  await wakeConversation(env, scope, authority.runId);
  const created = await env.DB.prepare('select id from leader_conversations where source_id=? and workspace_id=? and site_id=?').bind(authority.runId, scope.workspaceId, scope.siteId).all<{id:string}>();
  for (const conversation of created.results) await wakeConversation(env, scope, conversation.id);
  if (task.definition_version >= 3) {
    try { await dispatchPendingAgentEvents(env); } catch (error) { console.error('Agent event dispatch pending', authority.runId, String(error)); }
  }
  return { task_id: task.id, run_id: authority.runId, execution_id: authority.executionId, status: 'waiting', outcome: 'leader_ready' };
}
/** A child checkpoint is immutable; delivery can be retried independently of its Workflow event. */
export async function deliverLeaderReport(env: RuntimeAgentEnv, childRunId: string) {
  const child = await taskForRun(env.DB, childRunId);
  // Every finishing child passes through here; only a Leader's children can be queued (trigger in 0070).
  if (!child?.parent_task_id) return;
  const parent = await env.DB.prepare('select active_run_id,workspace_id,site_id,definition_version from agent_tasks where id=? and agent_id=?').bind(child.parent_task_id, 'growth_leader')
    .first<{active_run_id:string;workspace_id:string;site_id:string;definition_version:number}>();
  if (!parent) return;
  // Settle only the queued version read here; a newer state change re-queues with a later time.
  const queued = await env.DB.prepare('select queued_at from leader_report_outbox where child_task_id=?').bind(child.id).first<{queued_at:string}>();
  const settle = () => queued ? env.DB.prepare('delete from leader_report_outbox where child_task_id=? and queued_at=?').bind(child.id, queued.queued_at).run() : undefined;
  if (parent.definition_version >= 3) {
    await settle();
    await dispatchPendingAgentEvents(env);
    return;
  }
  if (child.status === 'running') { await settle(); return; }
  const scope = { workspaceId: parent.workspace_id, siteId: parent.site_id };
  const parentTask = await taskForRun(env.DB, parent.active_run_id);
  if (!parentTask || ['completed','cancelled','failed'].includes(parentTask.status)) { await settle(); return; }
  const id = `report:${child.id}:${child.execution_id}:${child.status}:${child.assignment_id}`;
  const exists = await env.DB.prepare('select id from leader_inputs where id=?').bind(id).first();
  if (!exists) await enqueueInput(env, scope, parent.active_run_id, { id, kind: 'child_report', actorId: child.agent_id,
    content: JSON.stringify({ task_ref: child.id, agent: child.agent_id, status: child.status, reason: child.reason, result: await readRuntimeJson(env.DB, child.output_json) }) });
  await settle();
  await wakeConversation(env, scope, parent.active_run_id);
}
/**
 * Recovery only: no scheduled business decisions. Runs every minute, so it reads the two queues of
 * undelivered work (migration 0070) — cost follows the backlog, never the conversation history.
 */
export async function recoverLeaderDeliveries(env: RuntimeAgentEnv) {
  const reports = await env.DB.prepare(`select c.active_run_id from leader_report_outbox o join agent_tasks c on c.id=o.child_task_id
    order by o.queued_at limit 50`).all<{active_run_id:string}>();
  for (const child of reports.results) { try { await deliverLeaderReport(env, child.active_run_id); } catch (error) { console.error('Leader report pending', child.active_run_id, String(error)); } }
  const unread = await env.DB.prepare(`select distinct c.id,c.workspace_id,c.site_id from leader_inputs i join leader_conversations c on c.id=i.conversation_id
    where i.read_at is null limit 50`).all<{id:string;workspace_id:string;site_id:string}>();
  for (const c of unread.results) { try { await wakeConversation(env, { workspaceId: c.workspace_id, siteId: c.site_id }, c.id); } catch (error) { console.error('Leader input pending', c.id, String(error)); } }
}
const delegatedColumns = `ch.id,ch.agent_id,ch.active_run_id,ch.status,ch.outcome,ch.reason,ch.agent_instance_id,ch.parent_task_id,ch.created_at,ch.updated_at,ch.goal_json,ch.assignment_id`;
type DelegatedRow = { id: string; agent_id: string; active_run_id: string; status: string; outcome: string; reason: string; agent_instance_id: string; parent_task_id: string; created_at: string; updated_at: string; goal_json: string; assignment_id: string };
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
/** Presentation only: titles, the Leader's brief and whether a person must respond. */
async function delegatedTasks(env: RuntimeAgentEnv, scope: LeaderScope, rows: DelegatedRow[]): Promise<LeaderTask[]> {
  if (!rows.length) return [];
  const teamScope = { db: env.DB, ...scope };
  const titled = await titledTasks(teamScope, rows.map(row => ({ ...row })) as Parameters<typeof titledTasks>[1]);
  const agents = [...new Set(rows.map(row => row.agent_id))];
  const pending = (await Promise.all(agents.map(agent => pendingWork(teamScope, agent)))).flat();
  return Promise.all(rows.map(async (row, index) => {
    const assignment = row.assignment_id ? await env.DB.prepare('select context_json from agent_task_assignments where id=? and task_id=?').bind(row.assignment_id, row.id).first<{ context_json: string }>() : null;
    const brief = assignment ? record(await readRuntimeJson(env.DB, assignment.context_json)) : record(record(await readRuntimeJson(env.DB, row.goal_json)).delegation);
    const { goal_json: _goal, assignment_id: _assignment, agent_instance_id: _instance, parent_task_id: _parent, active_run_id: _run, ...rest } = row;
    return { ...rest, agent_name: agentLabel(row.agent_id), display_title: titled[index]?.display_title || '', goal: text(brief.goal), why: text(brief.reason),
      attention_count: pending.filter(item => item.task_id === row.id).length } as LeaderTask;
  }));
}
function agentLabel(agentId: string) { try { return agentDefinition(agentId as AgentId).label; } catch { return ''; } }
function reportSummary(content: string): { task_id: string; summary: string } {
  try {
    const report = record(JSON.parse(content));
    const result = record(report.result);
    return { task_id: text(report.task_ref), summary: text(result.summary) || text(result.conclusion) || text(result.reason) || text(report.reason) };
  } catch { return { task_id: '', summary: '' }; }
}
/**
 * `tail` limits the transcript to its last N stored rows so a live view's cost does not grow with
 * the conversation; earlier inputs and delegation cards above that window are left out.
 */
export async function readLeaderDetail(env: RuntimeAgentEnv, scope: LeaderScope, id: string, options: { tail?: number } = {}): Promise<LeaderDetail | null> {
  const conversation = await getConversation(env, scope, id);
  if (!conversation) return null;
  const inputs = new Map((await env.DB.prepare('select * from leader_inputs where conversation_id=? order by position').bind(id)
    .all<{id:string;kind:string;content:string;created_at:string;read_at:string|null}>()).results.map(i => [i.id, i]));
  const inputMessage = (i: {id:string;kind:string;content:string;created_at:string}, pending: boolean): LeaderMessage => i.kind === 'child_report'
    ? { id: i.id, role: 'report', text: i.content, created_at: i.created_at, pending, ...reportSummary(i.content) }
    : { id: i.id, role: i.kind === 'assignment' ? 'assignment' : 'user', text: i.content, created_at: i.created_at, pending };
  // `+` keeps the scope checks off the site index so SQLite seeks children by parent, not every site task.
  const tasks = await delegatedTasks(env, scope, (await env.DB.prepare(`select ${delegatedColumns} from agent_tasks ch
    where ch.parent_task_id=(select id from agent_tasks where active_run_id=?) and +ch.workspace_id=? and +ch.site_id=? order by ch.created_at,ch.id`)
    .bind(id, scope.workspaceId, scope.siteId).all<DelegatedRow>()).results);
  // The runtime transcript order is what the Leader actually read; enqueue times are not.
  type Row = {sequence:number;message_key:string;role:string;message_json:string;decision_kind:string;created_at:string;definition_version:number;task_status:string;next_key:string|null};
  const columns = `m.sequence,m.message_key,m.role,m.message_json,m.decision_kind,m.created_at,t.definition_version,t.status task_status,
    (select next.message_key from agent_conversation_messages next where next.task_id=m.task_id and next.sequence>m.sequence order by next.sequence limit 1) next_key`;
  const rows = options.tail
    ? await env.DB.prepare(`select * from (select ${columns} from agent_conversation_messages m join agent_tasks t on t.id=m.task_id
        where t.active_run_id=? order by m.sequence desc limit ?) order by sequence`).bind(id, options.tail).all<Row>()
    : await env.DB.prepare(`select ${columns} from agent_conversation_messages m join agent_tasks t on t.id=m.task_id
        where t.active_run_id=? order by m.sequence`).bind(id).all<Row>();
  const first = rows.results[0];
  const hasEarlier = !!options.tail && rows.results.length === options.tail && !!first && first.sequence > 1;
  const messages: LeaderMessage[] = [];
  // Delegations and read inputs older than the window belong above it.
  const queue = hasEarlier ? tasks.filter(task => task.created_at >= first.created_at) : [...tasks];
  const consumed = new Set<string>();
  // Inputs read before the window belong above it (read_at is set when the transcript records them).
  if (hasEarlier) for (const input of inputs.values()) if (input.read_at) consumed.add(input.id);
  for (const row of rows.results) {
    while (queue.length && queue[0].created_at <= row.created_at) { const task = queue.shift()!; messages.push({ id: `task:${task.id}`, role: 'task', text: task.goal, created_at: task.created_at, task_id: task.id }); }
    if (row.role === 'user' && (row.message_key.startsWith('event:') || row.message_key.startsWith('event-followup:'))) {
      const native = await readRuntimeJson<{ content?: unknown }>(env.DB, row.message_json);
      const content = typeof native.content === 'string' ? native.content : '';
      try {
        const event = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)) as { type: string; summary: string; subject_id: string };
        messages.push({ id: row.message_key, role: 'event', text: event.type === 'content.article_ready_for_publication_review'
          ? `Pending pre-publication review: ${event.summary || event.subject_id}` : event.type === 'content.article_published'
            ? `Article is live: ${event.summary || event.subject_id}` : `Team item: ${event.summary || event.subject_id}`, created_at: row.created_at });
      } catch { messages.push({ id: row.message_key, role: 'event', text: 'Received automatic item', created_at: row.created_at }); }
    } else if (row.role === 'user' && row.message_key.startsWith('hitl-input:')) {
      const native = await readRuntimeJson<{ content?: unknown }>(env.DB, row.message_json);
      const content = typeof native.content === 'string' ? native.content : '';
      const payload = content.startsWith('Human response to the Agent-composed request:\n')
        ? content.slice('Human response to the Agent-composed request:\n'.length) : '';
      try {
        const response = JSON.parse(payload) as { values?: Record<string, string> };
        messages.push({ id: row.message_key, role: 'user', text: Object.entries(response.values || {}).map(([field, value]) => `${field}: ${value}`).join('\n') || 'Submitted information', created_at: row.created_at });
      } catch { messages.push({ id: row.message_key, role: 'user', text: 'Submitted information', created_at: row.created_at }); }
    } else if (row.role === 'user' && row.message_key.startsWith('leader-input:')) {
      const input = inputs.get(row.message_key.slice('leader-input:'.length));
      if (input) { consumed.add(input.id); messages.push(inputMessage(input, false)); }
    } else if (row.role === 'assistant' && row.decision_kind !== 'audit') {
      const native = await readRuntimeJson<Message>(env.DB, row.message_json);
      // Preserve draft responses in native history, but display the reviewed reply.
      if (row.definition_version >= 6 && native.role === 'assistant' && native.stopReason === 'stop' && !native.content.some(part => part.type === 'toolCall')
        && (row.next_key?.startsWith('leader-progress-closing:') || (!row.next_key && row.task_status === 'running'))) continue;
      const body = publicWorkText(native);
      if (body) messages.push({ id: row.message_key, role: 'assistant', text: body, created_at: row.created_at });
    }
  }
  for (const task of queue) messages.push({ id: `task:${task.id}`, role: 'task', text: task.goal, created_at: task.created_at, task_id: task.id });
  for (const input of inputs.values()) if (!consumed.has(input.id)) messages.push(inputMessage(input, true));
  const leaderTask = await taskForRun(env.DB, id);
  const hitlRequests = leaderTask && leaderTask.workspace_id === scope.workspaceId && leaderTask.site_id === scope.siteId
    ? await readLeaderHitlHistory(env.DB, leaderTask) : [];
  return { conversation, messages, tasks, hitl_requests: hitlRequests, ...(hasEarlier ? { has_earlier: true } : {}) };
}
