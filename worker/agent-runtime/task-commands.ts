import { closePendingConversationCalls } from './conversation-store';
import { runtimeAgentModule } from './agent-modules';
import { reconcileCancelledAgentRun } from './run-lifecycle';
import type { RuntimeAgentEnv } from './env';
import type { AgentRun } from './protocol';
import { taskResumeBlock, taskForRun } from './task-store';
import { getAgentRun, appendAgentEvent } from './store';
import { disposeRpcResource } from './rpc-resource';
import type { AgentId } from './definitions';
import { createRuntimeExecution, currentExecution, dispatchExecution, type RuntimeExecution } from './runtime-executions';

type CommandInput = { run: AgentRun; command: string; commandId: string; actorId: string; reason: string; value?: string; expectedTask?: string };
// Kept for deterministic external operation callers; it no longer names a Run.
export async function taskCommandRunId(commandId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(commandId));
  return `task-command-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function executeTaskCommand(env: RuntimeAgentEnv, input: CommandInput) {
  const task = await taskForRun(env.DB, input.run.id);
  if (!task) throw new Error('Task does not exist');
  const command = input.command === 'retry' ? 'resume' : input.command;
  const previous = await env.DB.prepare('select * from agent_runtime_commands where command_id=?').bind(input.commandId)
    .first<{ task_id: string; command: string; receipt_json: string; execution_id: string }>();
  if (previous && (previous.task_id !== task.id || previous.command !== command)) throw new Error('Command identity was reused for another action');
  if (previous?.receipt_json !== undefined && previous.receipt_json !== '{}') return JSON.parse(previous.receipt_json);
  if (!['cancel','resume','provide_input'].includes(command)) throw new Error('Unknown task command');
  if (command === 'provide_input' && (!input.value?.trim() || input.value.length > 20000)) throw new Error('Task input must contain 1–20000 characters');
  const at = new Date().toISOString();
  if (!previous) {
    if (input.expectedTask && input.expectedTask !== `${task.epoch}:${task.revision}:${task.updated_at}`) throw new Error('The task has changed, please refresh before handling');
    const predecessor = command === 'cancel' ? null : await currentExecution(env.DB, input.run.id);
    if (['completed','cancelled'].includes(task.status)) throw new Error('Task is closed');
    if (command !== 'cancel') {
      if (env.AGENT_RUNTIME_ENABLED !== 'true') throw new Error('Agent Runtime is disabled');
      if (command === 'provide_input' && task.status !== 'waiting') throw new Error('Task is not waiting for business input');
      if (!['waiting','paused','failed'].includes(task.status)) throw new Error('Task is not waiting for recovery');
      const block = await taskResumeBlock(env.DB, task);
      if (block) throw new Error(block);
    }
    const result = await env.DB.batch([
      env.DB.prepare(`insert or ignore into agent_runtime_commands(command_id,task_id,command,created_at,predecessor_json)
        select ?,?,?,?,? where exists(select 1 from agent_tasks where id=? and epoch=? and status=? and revision=? and updated_at=? and (pending_command_id='' or ?='cancel'))`)
        .bind(input.commandId, task.id, command, at, JSON.stringify(predecessor || {}), task.id, task.epoch, task.status, task.revision, task.updated_at, command),
      env.DB.prepare(`update agent_tasks set pending_command_id=? where id=? and epoch=? and status=? and (pending_command_id='' or ?='cancel')
        and exists(select 1 from agent_runtime_commands where command_id=?)`).bind(input.commandId, task.id, task.epoch, task.status, command, input.commandId),
    ]);
    if (!result[1].meta.changes) throw new Error('Another task command is being processed');
  }
  if (command === 'cancel') {
    // The whole descendant barrier is published before any external cleanup.
    await env.DB.prepare(`with recursive tree(id) as (select ? union all select t.id from agent_tasks t join tree p on t.parent_task_id=p.id)
      update agent_tasks set status='cancelled',outcome='cancelled',reason=?,updated_at=? where id in (select id from tree)
        and (status in ('running','waiting','paused') or (id=? and status='failed'))`)
      .bind(task.id, input.reason || 'Cancelled by user', at, task.id).run();
    const descendants = await env.DB.prepare(`with recursive tree(id) as (select ? union all select t.id from agent_tasks t join tree p on t.parent_task_id=p.id)
      select r.*,t.status as task_status,t.updated_at as task_updated_at,t.outcome as task_outcome,t.output_json as task_output_json
      from agent_runs r join agent_tasks t on t.active_run_id=r.id
      where t.id in (select id from tree) and t.status in ('failed','cancelled')`)
      .bind(task.id).all<AgentRun & {task_status:string;task_updated_at:string;task_outcome:string;task_output_json:string}>();
    for (const run of descendants.results) {
      if (run.task_status === 'cancelled') {
        await closePendingConversationCalls(env.DB, run.id, 'Task cancelled; remaining calls were not executed');
        await env.DB.prepare("update agent_runs set status='cancelled',phase='cancelled',finished_at=?,updated_at=? where id=? and status!='cancelled'")
          .bind(run.task_updated_at, run.task_updated_at, run.id).run();
        await reconcileCancelledAgentRun(env.DB, run, input.reason);
      } else {
        // The child may have committed failure just before its host was closed.
        await env.DB.prepare(`update agent_runs set status='failed',phase='failed',execution_outcome=?,output_json=?,finished_at=?,updated_at=?
          where id=? and status not in ('succeeded','failed','cancelled')`)
          .bind(run.task_outcome,run.task_output_json,run.task_updated_at,run.task_updated_at,run.id).run();
      }
      await env.DB.prepare("update agent_runtime_executions set status='cancelled',updated_at=? where run_id=? and status not in ('finished','superseded')").bind(at, run.id).run();
      try { await runtimeAgentModule(run.agent_id as AgentId).onCancel?.(env, run); }
      catch (error) { console.warn('External cancellation remains pending', String(error)); }
      if (run.workflow_id) try {
        const instance = await env.AGENT_WORKFLOW.get(run.workflow_id);
        try { await instance.terminate(); } finally { disposeRpcResource(instance); }
      } catch { /* The durable cancellation fence is already authoritative. */ }
    }
  } else {
    if (command === 'provide_input') await env.DB.prepare('insert or ignore into agent_task_inputs(id,task_id,actor_id,content,created_at) values(?,?,?,?,?)')
      .bind(input.commandId, task.id, input.actorId, input.value!, at).run();
    let execution = await currentExecution(env.DB, input.run.id);
    const claimed = await env.DB.prepare('select execution_id,predecessor_json from agent_runtime_commands where command_id=?').bind(input.commandId).first<{ execution_id: string; predecessor_json: string }>();
    if (!claimed?.execution_id) {
      const captured = JSON.parse(claimed!.predecessor_json) as RuntimeExecution;
      execution = await createRuntimeExecution(env.DB, input.run.id, captured.id ? captured : undefined, command);
      await env.DB.prepare('update agent_runtime_commands set execution_id=? where command_id=?').bind(execution.id, input.commandId).run();
    } else if (execution?.id !== claimed.execution_id) throw new Error('Command execution has already been superseded');
    await dispatchExecution(env, execution!);
  }
  await appendAgentEvent(env.DB, { runId: input.run.id, eventKey: `task.command:${input.commandId}`,
    kind: command === 'cancel' ? 'run_cancelled' : 'input_provided', phase: command === 'cancel' ? 'cancelled' : 'resuming',
    actorType: 'user', actorId: input.actorId, payload: { task_id: task.id, run_id: input.run.id, command } });
  const receipt = { run: await getAgentRun(env.DB, input.run.id), task: await taskForRun(env.DB, input.run.id) };
  await env.DB.batch([
    env.DB.prepare('update agent_runtime_commands set receipt_json=? where command_id=?').bind(JSON.stringify(receipt), input.commandId),
    env.DB.prepare("update agent_tasks set pending_command_id='' where id=? and pending_command_id=?").bind(task.id, input.commandId),
  ]);
  return receipt;
}
export async function recoverTaskCommand(env: RuntimeAgentEnv, input: CommandInput) {
  const command = await env.DB.prepare('select 1 from agent_runtime_commands where command_id=?').bind(input.commandId).first();
  return command ? executeTaskCommand(env, input) : null;
}
