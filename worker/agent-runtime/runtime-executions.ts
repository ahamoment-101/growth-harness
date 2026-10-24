import type { D1Database } from '@cloudflare/workers-types';
import type { RuntimeAgentEnv } from './env';
import type { RuntimeExecutionContext } from './execution-context';
import { authorizeTaskLifecycle, taskForRun, TaskStateError } from './task-store';
import { disposeRpcResource } from './rpc-resource';

export type RuntimeExecution = {
  id: string; task_id: string; run_id: string; epoch: number; workflow_id: string;
  status: 'dispatching' | 'running' | 'waiting' | 'recovering' | 'finished' | 'superseded' | 'cancelled';
  reason: string; error_json: string; durable_steps: number; retry_at: string;
};
export const EXECUTION_STEP_LIMIT = 200;
/** Input and continuation commit together against the state actually observed.
 * This is information, never an approval or a statement that the goal is met. */
export type WaitingTaskInput = {
  id: string; actorId: string; content: string; revision: number; updatedAt: string;
};
export class ExecutionHandoff extends Error {
  constructor() { super('Workflow capacity checkpoint reached'); }
}
export const authorityForExecution = (execution: RuntimeExecution): RuntimeExecutionContext => ({
  taskId: execution.task_id, runId: execution.run_id, executionId: execution.id, epoch: execution.epoch,
});
export async function currentExecution(db: D1Database, runId: string) {
  return db.prepare('select e.* from agent_runtime_executions e join agent_tasks t on t.execution_id=e.id where t.active_run_id=?')
    .bind(runId).first<RuntimeExecution>();
}

/** Controller-only CAS. A replacement names the exact predecessor it supersedes. */
export async function createRuntimeExecution(db: D1Database, runId: string, previous?: RuntimeExecution, reason = 'start', input?: WaitingTaskInput): Promise<RuntimeExecution> {
  const task = await taskForRun(db, runId);
  if (!task || task.active_run_id !== runId || ['completed','cancelled'].includes(task.status)) throw new TaskStateError('Task is closed');
  await authorizeTaskLifecycle(db, task);
  if (input && (!previous || !input.content.trim() || input.content.length > 20000)) throw new TaskStateError('Waiting input requires an observed execution and 1–20000 characters');
  if (!previous && task.execution_id) return (await currentExecution(db, runId))!;
  const epoch = previous ? previous.epoch + 1 : task.epoch;
  const id = `${task.id}:execution:${epoch}`;
  const workflowId = `wf_${runId.replace(/[^A-Za-z0-9_-]/g, '')}_${epoch}`;
  const at = new Date().toISOString();
  const inputGate = input ? `and t.status='waiting' and t.revision=? and t.updated_at=? and t.pending_command_id=''
    and not exists(select 1 from agent_work_responses r where r.task_id=t.id and r.receipt_json='')` : '';
  const gate = `exists(select 1 from agent_tasks t where t.id=? and t.active_run_id=? and t.epoch=? and t.execution_id=? and t.status not in ('completed','cancelled') ${inputGate}
    and not exists(with recursive ancestors(id,parent_task_id,status) as (
      select p.id,p.parent_task_id,p.status from agent_tasks p where p.id=t.parent_task_id
      union all select p.id,p.parent_task_id,p.status from agent_tasks p join ancestors a on p.id=a.parent_task_id
    ) select 1 from ancestors where status in ('completed','failed','cancelled')))`;
  const bindings = [task.id, runId, previous?.epoch ?? task.epoch, previous?.id || '', ...(input ? [input.revision, input.updatedAt] : [])];
  // Epoch alone cannot identify our commit: another controller can win the same
  // successor. Every following write must also belong to this exact input.
  const committed = `exists(select 1 from agent_tasks where id=? and execution_id=?)${input
    ? ' and exists(select 1 from agent_task_inputs where id=? and task_id=? and actor_id=? and content=?)' : ''}`;
  const commitBindings = [task.id, id, ...(input ? [input.id, task.id, input.actorId, input.content] : [])];
  await db.batch([
    ...(input ? [db.prepare(`insert into agent_task_inputs(id,task_id,actor_id,content,created_at)
      select ?,?,?,?,? where ${gate}`).bind(input.id, task.id, input.actorId, input.content, at, ...bindings)] : []),
    db.prepare(`insert or ignore into agent_runtime_executions(id,task_id,run_id,epoch,workflow_id,status,reason,created_at,updated_at)
      select ?,?,?,?,?,'dispatching',?,?,? where ${gate}`)
      .bind(id, task.id, runId, epoch, workflowId, reason, at, at, ...bindings),
    db.prepare(`update agent_tasks set epoch=?,execution_id=?,status='running',outcome='',reason='',updated_at=? where id=? and ${gate}
      and exists(select 1 from agent_runtime_executions where id=? and status='dispatching')`)
      .bind(epoch, id, at, task.id, ...bindings, id),
    db.prepare(`update agent_task_runs set epoch=? where run_id=? and ${committed}`)
      .bind(epoch, runId, ...commitBindings),
    ...(previous ? [db.prepare(`update agent_runtime_executions set status='superseded',updated_at=? where id=?
      and ${committed}`).bind(at, previous.id, ...commitBindings)] : []),
    db.prepare(`update agent_runs set workflow_id=?,status='queued',phase='dispatching',finished_at=''
      where id=? and ${committed}`).bind(workflowId, runId, ...commitBindings),
  ]);
  if (input && !await db.prepare('select 1 from agent_task_inputs where id=? and task_id=? and actor_id=? and content=?')
    .bind(input.id, task.id, input.actorId, input.content).first()) throw new TaskStateError('Waiting input lost its observed task state');
  const current = await currentExecution(db, runId);
  if (!current || current.id !== id) throw new TaskStateError('Execution handoff lost its predecessor');
  return current;
}

export async function activateRuntimeExecution(db: D1Database, context: RuntimeExecutionContext, workflowId: string): Promise<void> {
  const result = await db.prepare(`update agent_runtime_executions set status='running',updated_at=?
    where id=? and epoch=? and workflow_id=? and status in ('dispatching','running')
    and exists(select 1 from agent_tasks where id=? and active_run_id=? and epoch=? and execution_id=? and status='running')`)
    .bind(new Date().toISOString(), context.executionId, context.epoch, workflowId, context.taskId, context.runId, context.epoch, context.executionId).run();
  if (!result.meta.changes) throw new TaskStateError('Workflow does not own this execution');
}

export async function dispatchExecution(env: RuntimeAgentEnv, execution: RuntimeExecution): Promise<void> {
  const task = await taskForRun(env.DB, execution.run_id);
  if (!task || task.execution_id !== execution.id || task.status !== 'running') return;
  await authorizeTaskLifecycle(env.DB, task);
  const params = { runId: execution.run_id, workspaceId: task.workspace_id, siteId: task.site_id,
    agentId: task.agent_id, instanceId: task.agent_instance_id, execution: authorityForExecution(execution) };
  try {
    const instance = await env.AGENT_WORKFLOW.create({ id: execution.workflow_id, params });
    disposeRpcResource(instance);
  } catch (error) {
    try {
      const instance = await env.AGENT_WORKFLOW.get(execution.workflow_id);
      try {
        const state = await instance.status();
        if (['queued','running','waiting','waitingForPause','paused','complete'].includes(state.status)) return;
      } finally { disposeRpcResource(instance); }
    } catch { /* Retain the original create evidence and deterministic identity. */ }
    await env.DB.prepare(`update agent_runtime_executions set error_json=?,updated_at=? where id=? and status='dispatching'`)
      .bind(JSON.stringify({ message: String(error).slice(0, 2000) }), new Date().toISOString(), execution.id).run();
    throw error;
  }
}

export async function recoverExecution(env: RuntimeAgentEnv, execution: RuntimeExecution, reason: string): Promise<void> {
  const replacement = await createRuntimeExecution(env.DB, execution.run_id, execution, reason);
  await dispatchExecution(env, replacement);
}
