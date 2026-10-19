import { publicWorkText } from './work-progress';
import { persistRuntimeJson, readRuntimeJson } from './runtime-content';
import { agentDefinition, isAgentId } from './definitions';
import { toolResultView } from './tool-result-view';
import type { D1Database } from '@cloudflare/workers-types';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { hydrateTaskOperation, taskDataJson, taskJson, TaskStateError, type AgentTask, type TaskOperation } from './task-store';
import { estimateTextTokens } from './request-capacity';
import { capacityMessage, compactionMessage, conversationMessage, failedModelMessage, modelHistoryMessage } from './message-view';

type StoredMessage = { role: Message['role']; sequence: number; message_key: string; message_json: string };
export type ConversationCall = {
  call_id: string; assistant_sequence: number; call_index: number; tool_name: string;
  operation_id: string | null; result_sequence: number | null;
};
export type ConversationSnapshot = {
  instructions: string; context: unknown;
  normalDecisions: number;
  compaction: { version: number; throughSequence: number; summary: string } | null;
  hasMore: boolean;
  messages: Array<{ sequence: number; key: string; message: Message }>;
  calls: ConversationCall[];
};

// Every mutation rechecks execution ownership in SQL, including root cancellation.
const activeGate = `exists(select 1 from agent_tasks t join agent_tasks root on root.id = t.root_task_id
  where t.id = ? and t.active_run_id = ? and t.epoch = ? and t.status = 'running'
  and t.outcome != 'execution_recovering' and root.status in ('running','waiting','paused'))`;
const bindings = (task: AgentTask) => [task.id, task.active_run_id, task.epoch];

/** Count this task's model decisions, excluding tools and descendant model usage. */
export async function taskDecisionTurns(db: D1Database, task: AgentTask): Promise<number> {
  if (task.conversation_version !== 1) return Math.max(0, task.next_turn - 1);
  const row = await db.prepare(`select c.normal_decisions as count from agent_conversations c
    join agent_tasks t on t.id=c.task_id where c.task_id=? and t.workspace_id=? and t.site_id=?`)
    .bind(task.id, task.workspace_id, task.site_id).first<{count:number}>();
  return row?.count ?? 0;
}

export async function initializeConversation(db: D1Database, task: AgentTask, instructions: string, context: unknown, initialWorkspace?: unknown, toolManifest: unknown = []): Promise<void> {
  const inserted = await db.batch([
    db.prepare(`insert or ignore into agent_conversations(task_id,instructions,context_json,created_at,tool_manifest_json,definition_version)
      select ?,?,?,?,?,? where ${activeGate} and exists(select 1 from agent_tasks where id = ? and revision = ? and workspace_json = ?)`
      ).bind(task.id, instructions, await persistRuntimeJson(db, context), new Date().toISOString(), taskDataJson(toolManifest), task.definition_version, ...bindings(task), task.id, task.revision, task.workspace_json),
    db.prepare(`update agent_tasks set conversation_version = 1, workspace_json = case when changes() = 1 then coalesce(?,workspace_json) else workspace_json end where id = ? and ${activeGate}
      and exists(select 1 from agent_conversations where task_id = ?)`).bind(initialWorkspace === undefined ? null : taskDataJson(initialWorkspace), task.id, ...bindings(task), task.id),
  ]);
  if (!inserted[0].meta.changes) {
    const current = await db.prepare(`select c.task_id from agent_conversations c where c.task_id = ? and ${activeGate}`)
      .bind(task.id, ...bindings(task)).first();
    if (!current) throw new TaskStateError('Conversation initialization lost execution ownership');
  }
}

export async function readConversation(db: D1Database, task: AgentTask, options: {
  initial?: boolean; archive?: boolean; maxReadTokens?: number;
  /** Remaining capacity in the consumer's model view, checked at read boundaries. */
  remainingReadTokens?: (view: { instructions: string; messages: Message[] }) => Promise<number>;
} = {}): Promise<ConversationSnapshot | null> {
  const initial = await db.prepare(`select c.instructions,c.protocol_version,c.normal_decisions,${options.initial || options.archive ? 'c.context_json' : "'{}' as context_json"} from agent_conversations c join agent_tasks t on t.id = c.task_id
    where c.task_id = ? and t.workspace_id = ? and t.site_id = ?`)
    .bind(task.id, task.workspace_id, task.site_id).first<{ instructions: string; context_json: string; protocol_version: number; normal_decisions: number }>();
  if (!initial) return null;
  if (initial.protocol_version !== 1) throw new TaskStateError('Unsupported conversation protocol');
  const compaction = options.archive ? null : await db.prepare('select version,through_sequence,summary_json from agent_conversation_compactions where task_id=? order by version desc limit 1')
    .bind(task.id).first<{ version: number; through_sequence: number; summary_json: string }>();
  const after = compaction?.through_sequence || 0;
  let budget = options.archive ? Infinity : options.maxReadTokens ?? 128000;
  if (budget <= 0 || Number.isNaN(budget)) throw new TaskStateError('Model input window is unknown; configure its real capacity');
  const rows: ConversationSnapshot['messages'] = [];
  let cursor = after;
  let tokens = 0;
  let hasMore = false;
  const failedCalls = new Set<string>();
  // A database page is an I/O unit, never a summarization trigger. Continue
  // across pages until the actual semantic view reaches the requested budget.
  readPages: for (;;) {
    const page = await db.prepare('select sequence,message_key,message_json,role from agent_conversation_messages where task_id=? and sequence>? order by sequence limit 64')
      .bind(task.id, cursor).all<StoredMessage>();
    for (const row of page.results) {
      // Finish the assistant's complete result batch even across page boundaries.
      if (tokens >= budget && row.role !== 'toolResult') {
        const prefix: Message[] = compaction ? [compactionMessage(compaction.through_sequence, JSON.parse(compaction.summary_json))] : [];
        const remaining = await options.remainingReadTokens?.({ instructions: initial.instructions,
          messages: [...prefix, ...rows.map(value => modelHistoryMessage(value.message, failedCalls))] });
        if (remaining === undefined || !Number.isFinite(remaining) || remaining <= 0) { hasMore = true; break readPages; }
        // Continue from this cursor, without re-reading or treating a storage
        // boundary as a capacity failure. New material still uses the estimator.
        budget = tokens + remaining;
      }
      const saved = await readRuntimeJson<Message>(db, row.message_json);
      if (saved.role === 'assistant' && failedModelMessage(saved)) {
        for (const part of saved.content) if (part.type === 'toolCall') failedCalls.add(part.id);
      }
      // Raw failed output remains in the archive/physical receipt. It does not
      // consume the active view's memory merely to be filtered out later.
      const message = options.archive ? saved : saved.role === 'assistant' && failedModelMessage(saved)
        ? { ...saved, content: [] } : conversationMessage(saved);
      tokens += estimateTextTokens(taskDataJson(capacityMessage(modelHistoryMessage(message, failedCalls)))) + 8;
      rows.push({ sequence: row.sequence, key: row.message_key, message });
      cursor = row.sequence;
    }
    if (page.results.length < 64) break;
  }
  const calls = await db.prepare('select * from agent_conversation_calls where task_id=? and assistant_sequence>? and assistant_sequence<=? order by assistant_sequence,call_index')
    .bind(task.id, after, rows.at(-1)?.sequence || after).all<ConversationCall>();
  return { instructions: initial.instructions, context: await readRuntimeJson(db, initial.context_json), normalDecisions: initial.normal_decisions,
    compaction: compaction ? { version: compaction.version, throughSequence: compaction.through_sequence, summary: JSON.parse(compaction.summary_json) } : null,
    hasMore, messages: rows, calls: calls.results };

}

function comparable(message: Message): string {
  // SDK regenerates tool-result timestamps on replay; all semantic fields remain immutable.
  const { timestamp: _timestamp, ...value } = conversationMessage(message);
  // SDK and recovery constructors may insert the same object fields in different
  // orders. Preserve array/text order, but object key order is not semantic.
  return JSON.stringify(JSON.parse(taskDataJson(value)), (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

/** Append a complete SDK message. Partial stream deltas never become recovery authority. */
export async function appendConversationMessage(
  db: D1Database, task: AgentTask, key: string, message: Message, decisionKind: 'normal' | 'audit' = 'normal', publishProgress = false,
): Promise<number> {
  if (!key) throw new TaskStateError('Conversation message identity is required');
  if (isAgentId(task.agent_id)) message = await toolResultView(message, agentDefinition(task.agent_id).toolResultViews, task.parameter_contract_version || 0);
  const encoded = await persistRuntimeJson(db, conversationMessage(message));
  const previous = await db.prepare('select sequence,message_json from agent_conversation_messages where task_id = ? and message_key = ?')
    .bind(task.id, key).first<StoredMessage>();
  if (previous) {
    if (comparable(await readRuntimeJson<Message>(db, previous.message_json)) !== comparable(message)) throw new TaskStateError('Conversation message identity was reused with different content');
    return previous.sequence;
  }
  const last = await db.prepare('select coalesce(max(sequence),0) as sequence from agent_conversation_messages where task_id = ?')
    .bind(task.id).first<{ sequence: number }>();
  const sequence = Number(last?.sequence || 0) + 1;
  const calls = message.role === 'assistant' ? message.content.filter(c => c.type === 'toolCall') : [];
  if (new Set(calls.map(c => c.id)).size !== calls.length || calls.some(c => !c.id)) {
    throw new TaskStateError('Assistant tool call identities must be present and unique');
  }
  let call: ConversationCall | null = null;
  if (message.role === 'toolResult') {
    call = await db.prepare('select * from agent_conversation_calls where task_id = ? and call_id = ?')
      .bind(task.id, message.toolCallId).first<ConversationCall>();
    if (!call || call.tool_name !== message.toolName || call.result_sequence !== null) throw new TaskStateError('Tool result does not match a pending conversation call');
  }
  const pending = await db.prepare('select * from agent_conversation_calls where task_id = ? and result_sequence is null order by assistant_sequence,call_index limit 1')
    .bind(task.id).first<ConversationCall>();
  if (pending && (message.role !== 'toolResult' || message.toolCallId !== pending.call_id)) {
    throw new TaskStateError('Complete pending tool results in assistant order before appending another message');
  }
  // Once a domain tool commits terminal state, only results for already saved calls may close
  // the transcript. This gate cannot authorize a new model response or business effect.
  const terminalResultGate = message.role === 'toolResult' ? ` or exists(select 1 from agent_tasks t
    where t.id = ? and t.active_run_id = ? and t.epoch = ? and t.status in ('completed','waiting','paused','cancelled')
    and exists(select 1 from agent_task_operations o where o.id = t.last_operation_id and o.task_id = t.id and o.status = 'succeeded')
    and exists(select 1 from agent_conversation_calls c where c.task_id = t.id and c.call_id = ? and c.result_sequence is null))` : '';
  const terminalBindings = message.role === 'toolResult' ? [...bindings(task), message.toolCallId] : [];
  const insertedGate = `exists(select 1 from agent_conversation_messages where task_id = ? and sequence = ? and message_key = ? and message_json = ?)`;
  const publicText = publishProgress ? publicWorkText(message) : '';
  const result = await db.batch([
    db.prepare(`insert into agent_conversation_messages(task_id,sequence,message_key,role,message_json,created_at,decision_kind)
      select ?,?,?,?,?,?,? where (${activeGate}${terminalResultGate})
      and exists(select 1 from agent_conversations where task_id = ?)
      and (select coalesce(max(sequence),0) from agent_conversation_messages where task_id = ?) = ?`)
      .bind(task.id, sequence, key, message.role, encoded, new Date().toISOString(), decisionKind, ...bindings(task), ...terminalBindings, task.id, task.id, sequence - 1),
    ...(message.role === 'assistant' && decisionKind === 'normal' && !['error','aborted'].includes(message.stopReason) ? [
      db.prepare(`update agent_conversations set normal_decisions=normal_decisions+1 where task_id=? and changes()=1 and ${insertedGate}`)
        .bind(task.id, task.id, sequence, key, encoded),
    ] : []),
    ...(publicText ? [db.prepare(`insert into agent_work_notes(task_id,sequence,body,created_at) select ?,?,?,? where ${insertedGate}`)
      .bind(task.id, sequence, publicText, new Date().toISOString(), task.id, sequence, key, encoded)] : []),
    ...calls.map((value, index) => db.prepare(`insert into agent_conversation_calls(task_id,call_id,assistant_sequence,call_index,tool_name)
      select ?,?,?,?,? where ${insertedGate}`)
      .bind(task.id, value.id, sequence, index, value.name, task.id, sequence, key, encoded)),
    ...(call ? [db.prepare(`update agent_conversation_calls set result_sequence = ? where task_id = ? and call_id = ? and result_sequence is null and ${insertedGate}`)
      .bind(sequence, task.id, call.call_id, task.id, sequence, key, encoded)] : []),
  ]);
  if (!result[0].meta.changes) throw new TaskStateError('Conversation append lost its execution or sequence gate');
  return sequence;
}

/** Bind one SDK call to the existing atomic domain-operation receipt, without selecting a new action. */
export async function bindConversationOperation(
  db: D1Database, task: AgentTask, callId: string, context: unknown,
): Promise<TaskOperation> {
  const call = await db.prepare(`select c.*,m.message_json from agent_conversation_calls c
    join agent_conversation_messages m on m.task_id = c.task_id and m.sequence = c.assistant_sequence
    where c.task_id = ? and c.call_id = ?`).bind(task.id, callId).first<ConversationCall & { message_json: string }>();
  const message = call ? await readRuntimeJson<AssistantMessage>(db, call.message_json) : undefined;
  const action = message?.role === 'assistant' ? message.content.find(value => value.type === 'toolCall' && value.id === callId) : undefined;
  if (!call || action?.type !== 'toolCall') throw new TaskStateError('Conversation call was not durably saved');
  if (call.operation_id) {
    const existing = await db.prepare('select * from agent_task_operations where id = ? and task_id = ?')
      .bind(call.operation_id, task.id).first<TaskOperation>();
    if (!existing) throw new TaskStateError('Conversation operation receipt disappeared');
    return hydrateTaskOperation(db, existing);
  }
  const preceding = await db.prepare(`select c.call_id from agent_conversation_calls c join agent_conversation_messages m
    on m.task_id = c.task_id and m.sequence = c.assistant_sequence
    where c.task_id = ? and c.result_sequence is null
    and coalesce(json_extract(m.message_json, '$.stopReason'), '') not in ('error','aborted')
    and (c.assistant_sequence < ? or (c.assistant_sequence = ? and c.call_index < ?)) limit 1`)
    .bind(task.id, call.assistant_sequence, call.assistant_sequence, call.call_index).first();
  if (preceding) {
    throw new TaskStateError('A preceding conversation call is unfinished');
  }
  const operationId = `${task.id}:${task.next_turn}`;
  const at = new Date().toISOString();
  await db.batch([
    db.prepare(`insert into agent_task_operations(id,task_id,turn,status,context_json,action_json,created_at,updated_at)
      select ?,?,?,'ready',?,?,?,? where ${activeGate}
      and exists(select 1 from agent_tasks where id = ? and next_turn = ?)
      and exists(select 1 from agent_conversation_calls where task_id = ? and call_id = ? and operation_id is null and result_sequence is null)`)
      .bind(operationId, task.id, task.next_turn, taskJson(context), taskJson({ name: action.name, input: action.arguments }), at, at,
        ...bindings(task), task.id, task.next_turn, task.id, callId),
    db.prepare(`update agent_conversation_calls set operation_id = ? where task_id = ? and call_id = ? and operation_id is null
      and ${activeGate} and exists(select 1 from agent_task_operations where id = ? and task_id = ? and status = 'ready')`)
      .bind(operationId, task.id, callId, ...bindings(task), operationId, task.id),
  ]);
  const saved = await db.prepare(`select o.* from agent_task_operations o join agent_conversation_calls c on c.operation_id = o.id
    where c.task_id = ? and c.call_id = ?`).bind(task.id, callId).first<TaskOperation>();
  if (!saved) throw new TaskStateError('Conversation operation lost execution ownership');
  return hydrateTaskOperation(db, saved);
}

/** Pi may reject a call before invoking its executor. Those calls still need an
 * operation receipt, including calls skipped after a terminal tool in the batch. */
export async function recordConversationRejection(db: D1Database, task: AgentTask, callId: string, result: Message): Promise<void> {
  const existing = await db.prepare('select c.operation_id,m.message_json from agent_conversation_calls c join agent_conversation_messages m on m.task_id=c.task_id and m.sequence=c.assistant_sequence where c.task_id=? and c.call_id=?')
    .bind(task.id, callId).first<{ operation_id: string | null; message_json: string }>();
  if (!existing || existing.operation_id) return;
  const message = await readRuntimeJson<AssistantMessage>(db, existing.message_json);
  const call = message.content.find(part => part.type === 'toolCall' && part.id === callId);
  const id = `${task.id}:${task.next_turn}`;
  const at = new Date().toISOString();
  const gate = `exists(select 1 from agent_tasks where id=? and active_run_id=? and epoch=? and next_turn=?)`;
  const values = [task.id, task.active_run_id, task.epoch, task.next_turn];
  await db.batch([
    db.prepare(`insert or ignore into agent_task_operations(id,task_id,turn,status,context_json,action_json,output_json,error,created_at,updated_at)
      select ?,?,?,'failed','{}',?,?,'Call rejected or not executed',?,?
      from agent_conversation_calls c where c.task_id=? and c.call_id=? and c.operation_id is null and ${gate}`)
      .bind(id, task.id, task.next_turn, taskDataJson(call?.type === 'toolCall' ? { name: call.name, input: call.arguments, call_id: callId } : {}), taskDataJson({ executed: false, effects: 'none', result }), at, at, task.id, callId, ...values),
    db.prepare(`update agent_conversation_calls set operation_id=? where task_id=? and call_id=? and operation_id is null
      and exists(select 1 from agent_task_operations where id=?) and ${gate}`).bind(id, task.id, callId, id, ...values),
    db.prepare(`update agent_tasks set next_turn=next_turn+1 where id=? and ${gate}
      and exists(select 1 from agent_conversation_calls where task_id=? and call_id=? and operation_id=?)`)
      .bind(task.id, ...values, task.id, callId, id),
  ]);
}

/** A pending assistant is replayed through Pi with receipts, never regenerated by the provider. */
export function conversationResumePoint(snapshot: ConversationSnapshot): {
  messages: Message[]; pending: AssistantMessage | null; pendingKey: string | null;
} {
  const failedSequences = new Set(snapshot.messages.filter(row => failedModelMessage(row.message)).map(row => row.sequence));
  const failedCalls = new Set(snapshot.calls.filter(call => failedSequences.has(call.assistant_sequence)).map(call => call.call_id));
  const executable = snapshot.messages.map(row => ({ ...row, message: modelHistoryMessage(row.message, failedCalls) }));
  const unfinished = snapshot.calls.find(call => call.result_sequence === null && !failedSequences.has(call.assistant_sequence) && executable.some(row => row.sequence === call.assistant_sequence));
  const prefix: Message[] = snapshot.compaction ? [compactionMessage(snapshot.compaction.throughSequence, snapshot.compaction.summary)] : [];
  if (!unfinished) return { messages: [...prefix, ...executable.map(value => value.message)], pending: null, pendingKey: null };
  const entry = snapshot.messages.find(value => value.sequence === unfinished.assistant_sequence);
  if (entry?.message.role !== 'assistant') throw new TaskStateError('Pending tool call lost its assistant message');
  return { messages: [...prefix, ...executable.filter(value => value.sequence < unfinished.assistant_sequence).map(value => value.message)],
    pending: entry.message, pendingKey: entry.key };
}

export async function conversationInitialContext<T = Record<string, unknown>>(db: D1Database, taskId: string): Promise<T | null> {
  const row = await db.prepare('select context_json from agent_conversations where task_id=?').bind(taskId).first<{ context_json: string }>();
  return row ? readRuntimeJson<T>(db, row.context_json) : null;
}

export async function closePendingConversationCalls(db: D1Database, runId: string, reason: string): Promise<void> {
  const { taskForRun } = await import('./task-store');
  const rows = await db.prepare(`select c.call_id,c.tool_name,o.status,o.output_json from agent_conversation_calls c
    left join agent_task_operations o on o.id=c.operation_id join agent_tasks t on t.id=c.task_id
    where t.active_run_id=? and c.result_sequence is null order by c.assistant_sequence,c.call_index`)
    .bind(runId).all<{call_id:string;tool_name:string;status:string|null;output_json:string|null}>();
  for (const row of rows.results) {
    const task = (await taskForRun(db, runId))!;
    const output = row.status === 'succeeded' ? await readRuntimeJson(db, row.output_json || '{}') : { error: reason, executed: false, effects: row.status === 'running' || row.status === 'unknown' ? 'unknown' : 'none' };
    const message: Message = { role:'toolResult', toolCallId:row.call_id, toolName:row.tool_name, timestamp:Date.now(), isError:row.status!=='succeeded', content:[{type:'text',text:taskDataJson(output)}], details:output };
    await recordConversationRejection(db, task, row.call_id, message);
    await appendConversationMessage(db, task, `tool:${row.call_id}`, message);
  }
}
