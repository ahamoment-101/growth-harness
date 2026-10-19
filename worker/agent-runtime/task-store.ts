import { persistRuntimeJson, persistRuntimeRequest, runtimeJsonText } from './runtime-content';
import { executionContext } from './execution-context';
import { requestSampleStatement } from './request-accounting';
import type { D1Database } from '@cloudflare/workers-types';
import type { AgentDefinition } from './definitions';
import type { AgentRun } from './protocol';
import { redactRuntimeValuePreservingSize } from './protocol';
import { ToolContractError } from './tool-failure';

export type AgentTask = {
  runtime_version: number; execution_id: string; assignment_id: string;
  stage_policy_json?: string;
  parameter_contract_version?: number;
  conversation_version?: number;
  recovery_policy_version: number;
  child_reserve_units: number; child_reserve_calls: number; parent_task_id: string; root_task_id: string; external_calls: number; max_external_calls: number;
  id: string; workspace_id: string; site_id: string; agent_id: string; agent_instance_id: string;
  definition_version: number; status: 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled';
  reason: string; outcome: string; active_run_id: string; epoch: number; revision: number; next_turn: number;
  goal_json: string; workspace_json: string; output_json: string; max_turns: number;
  max_model_calls: number; max_tokens: number; reserved_tokens: number; model_calls: number;
  last_operation_id: string; created_at: string; updated_at: string;
};
export type TaskOperation = {
  id: string; task_id: string; turn: number;
  status: 'deciding' | 'ready' | 'running' | 'succeeded' | 'failed' | 'unknown';
  context_json: string; action_json: string; output_json: string; external_json: string; error: string;
};
export class TaskStateError extends Error {}
export class TaskPendingError extends Error {}
function assertOperation(task: AgentTask, operation: TaskOperation): void {
  if (operation.task_id !== task.id || operation.id !== `${task.id}:${operation.turn}`) throw new TaskStateError('Operation does not belong to this task');
}
export function taskJson(value: unknown): string {
  const json = JSON.stringify(redactRuntimeValuePreservingSize(value));
  if (new TextEncoder().encode(json).length > 2_000_000) throw new TaskStateError('Task document exceeds storage budget');
  return json;
}
/** Authoritative model messages must round-trip without log redaction changing SDK fields.
 * Callers pass only model context/results, never transport credentials. */
export function taskDataJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (!json) throw new TaskStateError('Task data is not serializable');
  return json;
}
export async function taskForRun(db: D1Database, runId: string): Promise<AgentTask | null> {
  const task = await db.prepare('select t.* from agent_tasks t join agent_task_runs r on r.task_id = t.id where r.run_id = ?')
    .bind(runId).first<AgentTask>();
  return task ? hydrateTask(db, task) : null;
}
async function hydrateTask(db: D1Database, task: AgentTask): Promise<AgentTask> {
  return { ...task, workspace_json: await runtimeJsonText(db, task.workspace_json), output_json: await runtimeJsonText(db, task.output_json) };
}
export async function hydrateTaskOperation(db: D1Database, operation: TaskOperation): Promise<TaskOperation> {
  return { ...operation, output_json: await runtimeJsonText(db, operation.output_json) };
}
export async function requireTask(db: D1Database, runId: string): Promise<AgentTask> {
  return (await readTaskLoopState(db, runId, false)).task;
}

/** A parent authorizes lifecycle effects, never executes as its child.
 * The original database capability still fences every write atomically. */
export async function requireParentAuthority(db: D1Database, parentRunId: string, workspaceId: string, siteId: string): Promise<AgentTask> {
  const parent = await requireTask(db, parentRunId);
  if (parent.workspace_id !== workspaceId || parent.site_id !== siteId) throw new TaskStateError('Child lifecycle scope mismatch');
  return parent;
}

/** Host controllers are unscoped; Agent callers may manage only themselves or
 * their direct children. Reading the target never grants its execution identity. */
export async function authorizeTaskLifecycle(db: D1Database, task: AgentTask): Promise<void> {
  const caller = executionContext(db);
  if (caller) {
    if (caller.taskId === task.id) await requireTask(db, task.active_run_id);
    else {
      const parent = await requireParentAuthority(db, caller.runId, task.workspace_id, task.site_id);
      if (task.parent_task_id !== parent.id) throw new TaskStateError('Child lifecycle requires its direct parent');
    }
  }
  if (await taskHasClosedAncestor(db, task.id)) throw new TaskStateError('Task ancestor is closed');
}
export async function readTaskLoopState(db: D1Database, runId: string, includeOperation = true): Promise<{ task: AgentTask; operation: TaskOperation | null }> {
  const task = await db.prepare(`select t.*, root.status as root_status,
    ${includeOperation ? `case when op.id is null then null else json_object('id',op.id,'task_id',op.task_id,'turn',op.turn,
      'status',op.status,'context_json',op.context_json,'action_json',op.action_json,'output_json',op.output_json,
      'external_json',op.external_json,'error',op.error,'created_at',op.created_at,'updated_at',op.updated_at) end` : 'null'} as pending_json
    from agent_tasks t
    join agent_task_runs r on r.task_id = t.id
    left join agent_tasks root on root.id = t.root_task_id
    ${includeOperation ? 'left join agent_task_operations op on op.task_id = t.id and op.turn = t.next_turn' : ''} where r.run_id = ?`)
    .bind(runId).first<AgentTask & { root_status: string | null; pending_json: string | null }>();
  if (!task || task.active_run_id !== runId || (task.status !== 'running' || task.outcome === 'execution_recovering')) throw new TaskStateError('Task is no longer writable by this execution');
  const execution = executionContext(db);
  if (execution && (execution.runId !== runId || execution.taskId !== task.id || execution.epoch !== task.epoch || execution.executionId !== task.execution_id)) throw new TaskStateError('Execution authority is stale');
  if (task.parent_task_id && !['running', 'waiting', 'paused'].includes(task.root_status || '')) throw new TaskStateError('Root task no longer permits execution');
  const { pending_json, root_status: _root, ...state } = task;
  return { task: await hydrateTask(db, state), operation: pending_json ? await hydrateTaskOperation(db, JSON.parse(pending_json) as TaskOperation) : null };
}
export async function taskHasClosedAncestor(db: D1Database, taskId: string): Promise<boolean> {
  return Boolean(await db.prepare(`select 1 where exists(with recursive ancestors(id,parent_task_id,status) as (
    select p.id,p.parent_task_id,p.status from agent_tasks t join agent_tasks p on p.id=t.parent_task_id where t.id=?
    union all select p.id,p.parent_task_id,p.status from agent_tasks p join ancestors a on p.id=a.parent_task_id
  ) select 1 from ancestors where status in ('completed','failed','cancelled'))`).bind(taskId).first());
}
export type TaskResumeBlock = { kind: 'ancestor_closed' | 'unknown_effect'; tool: string; message: string };
/** A fact about why the task cannot execute again; it does not choose the caller's next action. */
export async function taskResumeBlocker(db: D1Database, task: AgentTask): Promise<TaskResumeBlock | null> {
  if (await taskHasClosedAncestor(db, task.id)) return { kind: 'ancestor_closed', tool: '', message: 'Task ancestor is closed' };
  const pending = await readTaskOperation(db, task.id, task.next_turn);
  if (!pending || !(pending.status === 'unknown' || (pending.status === 'running' && JSON.parse(pending.external_json || '{}').replay_safety === 'unknown'))) return null;
  const tool = String((JSON.parse(pending.action_json || '{}') as { name?: unknown }).name || '');
  return { kind: 'unknown_effect', tool,
    message: `The interrupted ${tool || 'tool'} call has an unknown effect outcome that the Runtime cannot establish, so this task cannot execute again` };
}
export async function taskResumeBlock(db: D1Database, task: AgentTask): Promise<string | null> {
  return (await taskResumeBlocker(db, task))?.message ?? null;
}
export async function attachTask(db: D1Database, run: AgentRun, definition: AgentDefinition, retryOf?: string): Promise<AgentTask> {
  if (retryOf && retryOf !== run.id) throw new TaskStateError('A Task resumes its original Run');
  const attached = await taskForRun(db, run.id);
  if (attached) {
    await authorizeTaskLifecycle(db, attached);
    return attached;
  }
  const at = new Date().toISOString();
  {
    const parent = run.parent_run_id ? await taskForRun(db, run.parent_run_id) : null;
    if (run.parent_run_id && !parent) throw new TaskStateError('Parent task is missing');
    if (parent) await requireParentAuthority(db, parent.active_run_id, run.workspace_id, run.site_id);
    else if (executionContext(db)) throw new TaskStateError('An execution may only create child tasks');
    await db.batch([
      db.prepare(`insert into agent_tasks(id,workspace_id,site_id,agent_id,agent_instance_id,definition_version,recovery_policy_version,status,active_run_id,goal_json,max_turns,max_model_calls,max_tokens,created_at,updated_at,parent_task_id,root_task_id,child_reserve_units,child_reserve_calls,stage_policy_json,parameter_contract_version,runtime_version)
        select ?,?,?,?,?,?,1,'running',?,?,?,?,?,?,?,?,?,?,?,?,?,2
        where ? = '' or exists(select 1 from agent_tasks p where p.id = ? and p.active_run_id = ? and p.epoch = ? and p.status = 'running')`).bind(run.id, run.workspace_id, run.site_id, run.agent_id, run.agent_instance_id, definition.definitionVersion, run.id, run.summary_json, 0, 0, 0, at, at, parent?.id || '', parent?.root_task_id || run.id, 0, 0, '{}', definition.parameterContractVersion || 1, parent?.id || '', parent?.id || '', parent?.active_run_id || '', parent?.epoch || 0),
      db.prepare('insert into agent_task_runs(run_id,task_id,epoch) select ?,id,1 from agent_tasks where id=?').bind(run.id, run.id),
    ]);
  }
  // Receipt read: the DB remains scoped to the creator, not the new child.
  const created = await taskForRun(db, run.id);
  if (!created) throw new TaskStateError('Task attachment was not persisted');
  return created;
}
export async function readTaskOperation(db: D1Database, taskId: string, turn: number): Promise<TaskOperation | null> {
  const operation = await db.prepare('select * from agent_task_operations where task_id = ? and turn = ?').bind(taskId, turn).first<TaskOperation>();
  return operation ? hydrateTaskOperation(db, operation) : null;
}
export async function beginTaskDecision(db: D1Database, task: AgentTask, context: unknown): Promise<TaskOperation> {
  const at = new Date().toISOString();
  const inserted = await db.prepare(`insert or ignore into agent_task_operations(id,task_id,turn,status,context_json,created_at,updated_at)
    select ?,id,next_turn,'deciding',?,?,? from agent_tasks where id = ? and active_run_id = ? and epoch = ? and status = 'running'`)
    .bind(`${task.id}:${task.next_turn}`, taskJson(context), at, at, task.id, task.active_run_id, task.epoch).run();
  if (inserted.meta.changes) return { id: `${task.id}:${task.next_turn}`, task_id: task.id, turn: task.next_turn,
    status: 'deciding', context_json: taskJson(context), action_json: '{}', output_json: '{}', external_json: '{}', error: '' };
  const operation = await readTaskOperation(db, task.id, task.next_turn);
  if (!operation) throw new TaskStateError('Task decision lost execution ownership');
  return operation;
}
export async function setTaskAction(db: D1Database, task: AgentTask, operation: TaskOperation, action: unknown): Promise<void> {
  assertOperation(task, operation);
  const updated = await db.prepare(`update agent_task_operations set action_json = ?, status = 'ready' where id = ? and status = 'deciding'
    and exists(select 1 from agent_tasks where id = ? and active_run_id = ? and epoch = ? and status = 'running'
      and exists(select 1 from agent_tasks root where root.id = agent_tasks.root_task_id and root.status in ('running','waiting','paused')))`)
    .bind(taskJson(action), operation.id, task.id, task.active_run_id, task.epoch).run();
  if (!updated.meta.changes) throw new TaskStateError('Task decision lost execution ownership');
}
export async function finishTaskOperation(db: D1Database, task: AgentTask, operation: TaskOperation, output: unknown, error = ''): Promise<void> {
  assertOperation(task, operation);
  const at = new Date().toISOString();
  await db.batch([
    db.prepare(`update agent_task_operations set status = ?,output_json = ?,error = ?,updated_at = ? where id = ? and status not in ('succeeded','failed','unknown')
      and exists(select 1 from agent_tasks where id = ? and active_run_id = ? and epoch = ? and status = 'running'
      and exists(select 1 from agent_tasks root where root.id = agent_tasks.root_task_id and root.status in ('running','waiting','paused')))`)
      .bind(error ? 'failed' : 'succeeded', await persistRuntimeJson(db, redactRuntimeValuePreservingSize(output)), error.slice(0, 2000), at, operation.id, task.id, task.active_run_id, task.epoch),
    db.prepare(`update agent_tasks set next_turn = next_turn + 1,updated_at = ? where id = ? and next_turn = ? and active_run_id = ? and epoch = ? and status = 'running'
      and exists(select 1 from agent_task_operations where id = ? and status in ('succeeded','failed'))`)
      .bind(at, task.id, operation.turn, task.active_run_id, task.epoch, operation.id),
    ...requestSampleStatement(db, task.active_run_id, false, 2),
  ]);
}
// A receipt survives later edits, so replaying an old successful operation never overwrites them.
export async function writeTaskWorkspace(db: D1Database, task: AgentTask, operation: TaskOperation, expectedRevision: number, content: unknown, resultDetails: Record<string, unknown> = {}): Promise<{ revision: number }> {
  assertOperation(task, operation);
  const previous = await readTaskOperation(db, task.id, operation.turn);
  if (previous?.status === 'succeeded') return JSON.parse(previous.output_json) as { revision: number };
  const output = { ...resultDetails, revision: expectedRevision + 1 };
  const result = await db.batch([
    db.prepare(`update agent_tasks set workspace_json = ?,revision = revision + 1,last_operation_id = ?,updated_at = ?
      where id = ? and revision = ? and active_run_id = ? and epoch = ? and status = 'running'
      and exists(select 1 from agent_tasks root where root.id = agent_tasks.root_task_id and root.status in ('running','waiting','paused'))
      and next_turn = ? and exists(select 1 from agent_task_operations where id = ? and status in ('deciding','ready','running'))`)
      .bind(await persistRuntimeJson(db, redactRuntimeValuePreservingSize(content)), operation.id, new Date().toISOString(), task.id, expectedRevision, task.active_run_id, task.epoch, operation.turn, operation.id),
    db.prepare(`update agent_task_operations set status = 'succeeded',output_json = ? where id = ?
      and exists(select 1 from agent_tasks where id = ? and last_operation_id = ? and revision = ? and active_run_id = ? and epoch = ? and status = 'running'
      and exists(select 1 from agent_tasks root where root.id = agent_tasks.root_task_id and root.status in ('running','waiting','paused')))`)
      .bind(await persistRuntimeJson(db, redactRuntimeValuePreservingSize(output)), operation.id, task.id, operation.id, output.revision, task.active_run_id, task.epoch),
  ]);
  if (!result[0].meta.changes) {
    const current = await requireTask(db, task.active_run_id);
    if (current.revision !== expectedRevision) throw new ToolContractError('Workspace changed; read its current revision before editing', {
      kind: 'state_conflict', effects: 'preserved',
      issues: [{ path: ['expected_revision'], message: `Expected revision ${expectedRevision}; current revision is ${current.revision}` }],
      guidance: 'Read the current draft and apply only the intended revision. Earlier successful changes remain saved.',
    });
    throw new TaskStateError('Workspace operation lost its execution gate');
  }
  return output;
}
/** User cancellation targets the Task identity, including an execution transfer racing the command. */
export async function cancelTaskByIdentity(db: D1Database, taskId: string, reason: string): Promise<boolean> {
  const result = await db.prepare(`update agent_tasks set status='cancelled',reason=?,outcome='cancelled',updated_at=?
    where id=? and status in ('running','waiting','paused','failed')`)
    .bind(reason.slice(0,2000),new Date().toISOString(),taskId).run();
  return Boolean(result.meta.changes);
}

export async function stopTask(db: D1Database, runId: string, status: AgentTask['status'], reason: string, outcome = '', output: unknown = {}): Promise<boolean> {
  const result = await db.prepare(`update agent_tasks set status = ?,reason = ?,outcome = ?,output_json = ?,updated_at = ?
    where active_run_id = ? and ((status = 'running' and outcome != 'execution_recovering') or (? = 'cancelled' and status in ('running','waiting','paused','failed')))`)
    .bind(status, reason.slice(0, 2000), outcome, await persistRuntimeJson(db, redactRuntimeValuePreservingSize(output)), new Date().toISOString(), runId, status).run();
  return Boolean(result.meta.changes);
}

export async function finishTaskTerminal(db: D1Database, task: AgentTask, operation: TaskOperation,
  terminal: { status: 'completed' | 'waiting' | 'paused'; outcome: string; reason: string; output: unknown }): Promise<void> {
  assertOperation(task, operation);
  const at = new Date().toISOString();
  const result = await db.batch([
    db.prepare(`update agent_tasks set status = ?,outcome = ?,reason = ?,output_json = ?,last_operation_id = ?,next_turn = next_turn + 1,updated_at = ?
      where id = ? and active_run_id = ? and epoch = ? and next_turn = ? and status = 'running'
      and exists(select 1 from agent_tasks root where root.id = agent_tasks.root_task_id and root.status in ('running','waiting','paused'))`)
      .bind(terminal.status, terminal.outcome, terminal.reason.slice(0, 2000), await persistRuntimeJson(db, redactRuntimeValuePreservingSize(terminal.output)), operation.id, at, task.id, task.active_run_id, task.epoch, operation.turn),
    db.prepare(`update agent_task_operations set status = 'succeeded',output_json = ?,updated_at = ? where id = ?
      and exists(select 1 from agent_tasks where id = ? and active_run_id = ? and epoch = ? and last_operation_id = ?)`)
      .bind(await persistRuntimeJson(db, redactRuntimeValuePreservingSize(terminal.output)), at, operation.id, task.id, task.active_run_id, task.epoch, operation.id),
    ...(terminal.status === 'waiting' ? [db.prepare(`insert or ignore into agent_task_checkpoints(id,task_id,operation_id,assignment_id,output_json,created_at)
      select ?,?,?,?,?,? where exists(select 1 from agent_tasks where id=? and epoch=? and last_operation_id=? and status='waiting')`)
      .bind(operation.id, task.id, operation.id, task.assignment_id || `${task.id}:initial`, await persistRuntimeJson(db, redactRuntimeValuePreservingSize(terminal.output)), at, task.id, task.epoch, operation.id)] : []),
  ]);
  if (!result[0].meta.changes) throw new TaskStateError('Task terminal lost its execution gate');
}
export async function taskHistory(db: D1Database, taskId: string, limit = 8): Promise<TaskOperation[]> {
  const rows = await db.prepare("select * from agent_task_operations where task_id = ? and status in ('succeeded','failed') order by turn desc limit ?").bind(taskId, limit).all<TaskOperation>();
  return Promise.all(rows.results.reverse().map(operation => hydrateTaskOperation(db, operation)));
}
/** Three round trips: current gate, durable receipt, atomic reservation/claim.
 * The SQL gate is rechecked in the transaction; the earlier snapshot is not authority. */
export async function prepareTaskModel(db: D1Database, input: {
  runId: string; reservationId: string; operationId: string; tokens: number;
  request: unknown; reusePredecessor: boolean; excludeFailedAssistant?: boolean; reserveCalls?: number;
}): Promise<{ response: string; receiptId: string } | { response: null }> {
  const task = await requireTask(db, input.runId);
  const operationId = `${task.id}:${input.operationId}`;
  let existing = await db.prepare(`select id,status,response_json from agent_task_model_reservations
    where task_id = ? and (id = ? or (? = 1 and operation_id = ? and status = 'succeeded'))
    order by case when id = ? then 0 else 1 end,created_at desc limit 1`)
    .bind(task.id, input.reservationId, input.reusePredecessor ? 1 : 0, operationId, input.reservationId).first<{ id: string; status: string; response_json: string }>();
  if (existing?.status === 'succeeded') {
    const response = await runtimeJsonText(db, existing.response_json);
    if (!input.excludeFailedAssistant || !['error','aborted','length'].includes(JSON.parse(response).stopReason)) return { response, receiptId: existing.id };
    if (existing.id === input.reservationId) throw new TaskStateError('An incomplete physical response is immutable; recovery needs a new execution');
    existing = null;
  }
  if (existing && existing.status !== 'reserved') throw new TaskStateError('Model request outcome is unknown; this physical request cannot be replayed');
  const rootId = task.root_task_id || task.id;
  const gate = `exists(select 1 from agent_tasks t join agent_tasks root on root.id = t.root_task_id
    where t.id = ? and t.active_run_id = ? and t.epoch = ? and t.status = 'running'
    and t.outcome != 'execution_recovering' and root.status in ('running','waiting','paused'))`;
  const result = await db.batch([
    db.prepare(`insert or ignore into agent_task_model_reservations(id,task_id,tokens,created_at,operation_id)
      select ?,t.id,?,?,? from agent_tasks t join agent_tasks root on root.id = t.root_task_id
      where t.id = ? and t.active_run_id = ? and t.epoch = ? and t.status = 'running'
      and t.outcome != 'execution_recovering' and root.status in ('running','waiting','paused')
      `)
      .bind(input.reservationId, input.tokens, new Date().toISOString(), operationId,
        task.id, input.runId, task.epoch),
    db.prepare(`update agent_tasks set reserved_tokens = reserved_tokens + (select tokens from agent_task_model_reservations where id = ?),model_calls = model_calls + 1
      where id in (?,?) and exists(select 1 from agent_task_model_reservations where id = ? and charged = 0) and ${gate}`)
      .bind(input.reservationId, task.id, rootId, input.reservationId, task.id, input.runId, task.epoch),
    db.prepare(`update agent_task_model_reservations set charged = 1,status = 'running',request_json = ?,operation_id = ?
      where id = ? and status = 'reserved' and ${gate}`)
      .bind(await persistRuntimeRequest(db, input.request), operationId, input.reservationId, task.id, input.runId, task.epoch),
  ]);
  if (!result[2].meta.changes) {
    await requireTask(db, input.runId);
    const concurrent = await db.prepare('select status from agent_task_model_reservations where id = ? and task_id = ?')
      .bind(input.reservationId, task.id).first<{status: string}>();
    if (concurrent) throw new TaskStateError('Model request outcome is unknown; this physical request cannot be replayed');
    throw new TaskStateError('Model request lost task execution authority');
  }
  return { response: null };
}

// Conservative reservations include input bytes, output allowance and tools. Unknown usage remains reserved.
export async function reserveTaskModel(db: D1Database, task: AgentTask, id: string, tokens: number): Promise<void> {
  const previous = await db.prepare('select task_id from agent_task_model_reservations where id = ?').bind(id).first<{ task_id: string }>();
  if (previous) {
    if (previous.task_id !== task.id) throw new TaskStateError('Model reservation belongs to another task');
    return;
  }
  await requireTask(db, task.active_run_id);
  const rootId = task.root_task_id || task.id;
  const result = await db.batch([
    db.prepare(`insert into agent_task_model_reservations(id,task_id,tokens,created_at)
      select ?,id,?,? from agent_tasks where id = ? and active_run_id = ? and status = 'running' and epoch = ?
      and exists(select 1 from agent_tasks r where r.id = ? and r.status in ('running','waiting','paused'))`)
      .bind(id, tokens, new Date().toISOString(), task.id, task.active_run_id, task.epoch, rootId),
    db.prepare(`update agent_tasks set reserved_tokens = reserved_tokens + ?,model_calls = model_calls + 1
      where id in (?,?) and exists(select 1 from agent_task_model_reservations where id = ? and charged = 0)`)
      .bind(tokens, task.id, rootId, id),
    db.prepare("update agent_task_model_reservations set charged = 1 where id = ? and charged = 0").bind(id),
  ]);
  if (!result[0].meta.changes) throw new TaskStateError('Model request lost task execution authority');
}

/** Commit a confirmed response and settle cumulative usage in one transaction.
 * Cancellation/ownership is checked after the network call, inside both writes. */
export async function commitTaskModel(db: D1Database, runId: string, id: string, response: unknown, actualTokens?: number): Promise<void> {
  const actual = actualTokens === undefined ? null : Math.max(0, Math.ceil(actualTokens));
  const gate = `exists(select 1 from agent_task_model_reservations r join agent_tasks t on t.id = r.task_id
    join agent_tasks root on root.id = t.root_task_id
    join agent_task_runs tr on tr.task_id = t.id and tr.run_id = ?
    where r.id = ? and t.active_run_id = tr.run_id and t.epoch = tr.epoch
    and t.status = 'running' and t.outcome != 'execution_recovering' and root.status in ('running','waiting','paused'))`;
  const result = await db.batch([
    db.prepare(`update agent_tasks set reserved_tokens = reserved_tokens +
      (select coalesce(?,tokens) - tokens from agent_task_model_reservations where id = ?)
      where id in (select task_id from agent_task_model_reservations where id = ? union
        select root_task_id from agent_tasks where id = (select task_id from agent_task_model_reservations where id = ?))
      and exists(select 1 from agent_task_model_reservations where id = ? and status = 'running') and ${gate}`)
      .bind(actual,id,id,id,id,runId,id),
    db.prepare(`update agent_task_model_reservations set tokens = coalesce(?,tokens),status = 'succeeded',response_json = ?
      where id = ? and status = 'running' and ${gate}`).bind(actual,await persistRuntimeJson(db, response),id,runId,id),
    ...requestSampleStatement(db, runId, false, 2),
  ]);
  if (!result[1].meta.changes) {
    await requireTask(db, runId);
    const saved = await db.prepare("select status from agent_task_model_reservations where id = ?").bind(id).first<{status:string}>();
    if (saved?.status !== 'succeeded') throw new TaskStateError('Model result lost its execution gate');
  }
}

export async function settleTaskModel(db: D1Database, id: string, response: unknown, actualTokens?: number): Promise<void> {
  const reservation = await db.prepare('select task_id,tokens,status from agent_task_model_reservations where id = ?').bind(id)
    .first<{ task_id: string; tokens: number; status: string }>();
  if (!reservation || reservation.status === 'succeeded') return;
  const tokens = actualTokens === undefined ? reservation.tokens : Math.max(0, Math.ceil(actualTokens));
  await db.batch([
    db.prepare(`update agent_tasks set reserved_tokens = reserved_tokens + ? where id in (?, (select root_task_id from agent_tasks where id = ?))
      and exists(select 1 from agent_task_model_reservations where id = ? and status != 'succeeded')`)
      .bind(tokens - reservation.tokens, reservation.task_id, reservation.task_id, id),
    db.prepare("update agent_task_model_reservations set tokens = ?,status = 'succeeded',response_json = ? where id = ? and status != 'succeeded'")
      .bind(tokens, taskJson(response), id),
  ]);
}

// Called only for a positively identified refusal at our fetch boundary.
export async function releaseUnsentModel(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare(`update agent_tasks set model_calls = model_calls - 1, reserved_tokens = reserved_tokens -
      (select tokens from agent_task_model_reservations where id = ?)
      where id in (select task_id from agent_task_model_reservations where id = ? union
        select root_task_id from agent_tasks where id = (select task_id from agent_task_model_reservations where id = ?))
      and exists(select 1 from agent_task_model_reservations where id = ? and charged = 1 and status = 'running')`).bind(id,id,id,id),
    db.prepare("update agent_task_model_reservations set charged = 0,tokens = 0,status = 'failed' where id = ? and charged = 1 and status = 'running'").bind(id),
  ]);
}
