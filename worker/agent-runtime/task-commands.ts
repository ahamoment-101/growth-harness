import { closeCancelledConversationCalls, type TaskCancellationScope } from './conversation-store';
import { runtimeAgentModule } from './agent-modules';
import { reconcileCancelledAgentRun } from './run-lifecycle';
import type { RuntimeAgentEnv } from './env';
import type { AgentRun } from './protocol';
import { taskResumeBlock, taskForRun, type AgentTask } from './task-store';
import { getAgentRun, appendAgentEvent } from './store';
import { disposeRpcResource } from './rpc-resource';
import type { AgentId } from './definitions';
import { createRuntimeExecution, currentExecution, dispatchExecution, type RuntimeExecution } from './runtime-executions';
import { executionContext } from './execution-context';
import { settleClosedHostRequests } from './task-recovery';

type CommandInput = { run: AgentRun; command: string; commandId: string; actorId: string; reason: string; value?: string; expectedTask?: string };
// Bounds a controller claim after an interrupted HTTP request; each cleanup renews it.
const CANCELLATION_CLAIM_MS = 60_000;
const cancellationControllerIdentity = `controller.id=agent_runtime_commands.task_id
  and controller.active_run_id=json_extract(predecessor_json,'$.cancellation.controller.active_run_id')
  and controller.workspace_id=json_extract(predecessor_json,'$.cancellation.controller.workspace_id')
  and controller.site_id=json_extract(predecessor_json,'$.cancellation.controller.site_id')
  and controller.root_task_id=json_extract(predecessor_json,'$.cancellation.controller.root_task_id')`;
const cancellationControllerGate = `exists(select 1 from agent_tasks controller where ${cancellationControllerIdentity}
  and controller.epoch=json_extract(predecessor_json,'$.cancellation.controller.epoch'))`;
const cancellationClaimGate = `exists(select 1 from agent_tasks controller where ${cancellationControllerIdentity}
  and controller.status!='completed' and (controller.status!='cancelled' or controller.epoch=json_extract(predecessor_json,'$.cancellation.controller.epoch')))`;
const cancellationState = (task: AgentTask) => ({ cancellation: { controller: {
  id: task.id, active_run_id: task.active_run_id, epoch: task.epoch, workspace_id: task.workspace_id, site_id: task.site_id, root_task_id: task.root_task_id,
}, token: '', leaseUntil: '', done: [] } });

async function cancelTaskTree(env: RuntimeAgentEnv, task: AgentTask, input: CommandInput, at: string) {
  const scope: TaskCancellationScope = { commandId: input.commandId, token: crypto.randomUUID() };
  // Old cancel commands saved no scope. Only their still-pending controller
  // command may acquire cleanup authority; execution callers are rejected above.
  await env.DB.prepare(`update agent_runtime_commands set predecessor_json=? where command_id=? and task_id=? and command='cancel'
    and predecessor_json='{}' and receipt_json='{}' and exists(select 1 from agent_tasks where id=? and active_run_id=?
      and workspace_id=? and site_id=? and root_task_id=? and pending_command_id=? and status!='completed')`)
    .bind(JSON.stringify(cancellationState(task)), scope.commandId, task.id, task.id, task.active_run_id,
      task.workspace_id, task.site_id, task.root_task_id, scope.commandId).run();
  const claim = await env.DB.prepare(`update agent_runtime_commands set predecessor_json=json_set(predecessor_json,
    '$.cancellation.token',?,'$.cancellation.leaseUntil',?) where command_id=? and task_id=? and command='cancel'
    and ${cancellationClaimGate} and (coalesce(json_extract(predecessor_json,'$.cancellation.token'),'')=''
      or json_extract(predecessor_json,'$.cancellation.leaseUntil')<=?)`)
    .bind(scope.token, new Date(Date.now() + CANCELLATION_CLAIM_MS).toISOString(), scope.commandId, task.id, at).run();
  if (!claim.meta.changes) throw new Error('Cancellation controller scope is stale or cleanup is already being processed');
  const errors: string[] = [];
  try {
    // Publish the complete tenant-scoped descendant barrier before external cleanup.
    await env.DB.batch([
      // A cancel targets the Task, even if a legitimate handoff won just before
      // this transaction. Capture that epoch and publish its barrier atomically.
      env.DB.prepare(`update agent_runtime_commands set predecessor_json=json_set(predecessor_json,'$.cancellation.controller.epoch',
        (select epoch from agent_tasks where id=?),'$.cancellation.leaseUntil',?) where command_id=?
        and json_extract(predecessor_json,'$.cancellation.token')=? and ${cancellationClaimGate}`)
        .bind(task.id, new Date(Date.now() + CANCELLATION_CLAIM_MS).toISOString(), scope.commandId, scope.token),
      env.DB.prepare(`with recursive tree(id) as (select ? union all select t.id from agent_tasks t join tree p on t.parent_task_id=p.id
      where t.workspace_id=? and t.site_id=? and t.root_task_id=?)
      update agent_tasks set status='cancelled',outcome='cancelled',reason=?,updated_at=? where id in (select id from tree)
      and (status in ('running','waiting','paused') or (id=? and status='failed'))
      and exists(select 1 from agent_runtime_commands where command_id=? and json_extract(predecessor_json,'$.cancellation.token')=?
        and ${cancellationControllerGate} and exists(select 1 from agent_tasks where id=? and status!='completed'))`)
        .bind(task.id, task.workspace_id, task.site_id, task.root_task_id, input.reason || 'Cancelled by user', at, task.id, scope.commandId, scope.token, task.id),
    ]);
    if (!await env.DB.prepare(`select 1 from agent_runtime_commands where command_id=? and ${cancellationControllerGate}
      and exists(select 1 from agent_tasks where id=? and status='cancelled')`).bind(scope.commandId,task.id).first()) throw new Error('Cancellation lost its Task barrier');
    const descendants = await env.DB.prepare(`with recursive tree(id) as (select ? union all select t.id from agent_tasks t join tree p on t.parent_task_id=p.id
      where t.workspace_id=? and t.site_id=? and t.root_task_id=?)
      select r.*,t.status as task_status,t.updated_at as task_updated_at,t.outcome as task_outcome,t.output_json as task_output_json
      from agent_runs r join agent_tasks t on t.active_run_id=r.id
      where t.id in (select id from tree) and t.status in ('failed','cancelled') order by t.id`)
      .bind(task.id, task.workspace_id, task.site_id, task.root_task_id)
      .all<AgentRun & {task_status:string;task_updated_at:string;task_outcome:string;task_output_json:string}>();
    for (const run of descendants.results) {
      const target = (await taskForRun(env.DB, run.id))!;
      const attempt = async (step: string, cleanup: () => Promise<unknown>) => {
        const key = `${run.id}:${step}`;
        try {
          const renewed = await env.DB.prepare(`update agent_runtime_commands set predecessor_json=json_set(predecessor_json,'$.cancellation.leaseUntil',?)
            where command_id=? and json_extract(predecessor_json,'$.cancellation.token')=? and ${cancellationControllerGate}
            and exists(select 1 from agent_tasks t where t.id=? and t.active_run_id=? and t.epoch=? and t.workspace_id=? and t.site_id=?
              and t.root_task_id=? and t.status=? and t.id in (with recursive tree(id) as (select ? union all
                select child.id from agent_tasks child join tree p on child.parent_task_id=p.id
                where child.workspace_id=? and child.site_id=? and child.root_task_id=?) select id from tree))
            and not exists(select 1 from json_each(predecessor_json,'$.cancellation.done') where value=?)`)
            .bind(new Date(Date.now() + CANCELLATION_CLAIM_MS).toISOString(), scope.commandId, scope.token,
              target.id, target.active_run_id, target.epoch, target.workspace_id, target.site_id, target.root_task_id, target.status,
              task.id, task.workspace_id, task.site_id, task.root_task_id, key).run();
          if (!renewed.meta.changes) {
            const done = await env.DB.prepare(`select 1 from agent_runtime_commands,json_each(predecessor_json,'$.cancellation.done')
              where command_id=? and value=?`).bind(scope.commandId,key).first();
            if (done) return;
            throw new Error('Cancellation controller claim was lost');
          }
          await cleanup();
          const saved = await env.DB.prepare(`update agent_runtime_commands set predecessor_json=json_insert(predecessor_json,'$.cancellation.done[#]',?)
            where command_id=? and json_extract(predecessor_json,'$.cancellation.token')=? and ${cancellationControllerGate}`)
            .bind(key, scope.commandId, scope.token).run();
          if (!saved.meta.changes) throw new Error('Cancellation cleanup receipt could not be saved');
        } catch (error) { errors.push(`${run.id} ${step}: ${error instanceof Error ? error.message : String(error)}`); }
      };
      if (run.task_status === 'cancelled') {
        await attempt('conversation', () => closeCancelledConversationCalls(env.DB, target, scope, 'Task cancelled; no further calls will execute'));
        await attempt('run', () => env.DB.prepare("update agent_runs set status='cancelled',phase='cancelled',finished_at=?,updated_at=? where id=? and status!='cancelled'")
          .bind(run.task_updated_at, run.task_updated_at, run.id).run());
        await attempt('domain', () => reconcileCancelledAgentRun(env.DB, run, input.reason));
      } else {
        // Preserve a child's already committed failure while stopping its host.
        await attempt('run', () => env.DB.prepare(`update agent_runs set status='failed',phase='failed',execution_outcome=?,output_json=?,finished_at=?,updated_at=?
          where id=? and status not in ('succeeded','failed','cancelled')`)
          .bind(run.task_outcome,run.task_output_json,run.task_updated_at,run.task_updated_at,run.id).run());
      }
      await attempt('executions', () => env.DB.prepare("update agent_runtime_executions set status='cancelled',updated_at=? where run_id=? and status not in ('finished','superseded')").bind(at, run.id).run());
      await attempt('external', async () => { await runtimeAgentModule(run.agent_id as AgentId).onCancel?.(env, run); });
      if (run.workflow_id) {
        let hostClosed = false;
        await attempt(`host:${run.workflow_id}`, async () => {
          const instance = await env.AGENT_WORKFLOW.get(run.workflow_id);
          try {
            // Reconcile a successful termination whose local receipt was interrupted.
            if (!['terminated','complete','errored'].includes((await instance.status()).status)) {
              await instance.terminate();
              if (!['terminated','complete','errored'].includes((await instance.status()).status)) throw new Error('Workflow host closure is not confirmed');
            }
            hostClosed = true;
          } finally { disposeRpcResource(instance); }
        });
        await attempt(`model-receipts:${run.workflow_id}`, async () => {
          if (!hostClosed) {
            const instance = await env.AGENT_WORKFLOW.get(run.workflow_id);
            try {
              if (!['terminated','complete','errored'].includes((await instance.status()).status)) throw new Error('Workflow host closure is not confirmed');
            } finally { disposeRpcResource(instance); }
          }
          await settleClosedHostRequests(env.DB, target.id, run.id, new Date());
        });
      } else if (await env.DB.prepare(`select 1 where exists(select 1 from agent_task_model_reservations where task_id=? and status='running')
        or exists(select 1 from agent_model_attempts where run_id=? and status='running')`).bind(target.id,run.id).first()) {
        errors.push(`${run.id} model-receipts: Workflow host identity is unavailable; closure is not confirmed`);
      }
    }
    if (errors.length) throw new Error(`Task cancellation cleanup remains pending: ${errors.join('; ')}`);
  } finally {
    await env.DB.prepare(`update agent_runtime_commands set predecessor_json=json_set(predecessor_json,'$.cancellation.token','','$.cancellation.leaseUntil','')
      where command_id=? and json_extract(predecessor_json,'$.cancellation.token')=?`).bind(scope.commandId,scope.token).run();
  }
}
// Kept for deterministic external operation callers; it no longer names a Run.
export async function taskCommandRunId(commandId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(commandId));
  return `task-command-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function executeTaskCommand(env: RuntimeAgentEnv, input: CommandInput) {
  const task = await taskForRun(env.DB, input.run.id);
  if (!task) throw new Error('Task does not exist');
  if (task.active_run_id !== input.run.id || task.workspace_id !== input.run.workspace_id || task.site_id !== input.run.site_id) throw new Error('Task command scope mismatch');
  const command = input.command === 'retry' ? 'resume' : input.command;
  const previous = await env.DB.prepare('select * from agent_runtime_commands where command_id=?').bind(input.commandId)
    .first<{ task_id: string; command: string; receipt_json: string; execution_id: string }>();
  if (previous && (previous.task_id !== task.id || previous.command !== command)) throw new Error('Command identity was reused for another action');
  if (previous?.receipt_json !== undefined && previous.receipt_json !== '{}') return JSON.parse(previous.receipt_json);
  if (command === 'cancel' && executionContext(env.DB)) throw new Error('Cancellation cleanup requires controller authority');
  if (!['cancel','resume','provide_input'].includes(command)) throw new Error('Unknown task command');
  if (command === 'provide_input' && (!input.value?.trim() || input.value.length > 20000)) throw new Error('Task input must contain 1–20000 characters');
  const at = new Date().toISOString();
  if (!previous) {
    if (input.expectedTask && input.expectedTask !== `${task.epoch}:${task.revision}:${task.updated_at}`) throw new Error('The task has changed, please refresh before handling');
    const predecessor = command === 'cancel' ? cancellationState(task) : await currentExecution(env.DB, input.run.id);
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
        select ?,?,?,?,? where exists(select 1 from agent_tasks where id=? and epoch=? and status=? and revision=? and updated_at=? and
          (pending_command_id='' or pending_command_id=? or (?='cancel' and not exists(select 1 from agent_runtime_commands where command_id=pending_command_id and command='cancel' and receipt_json='{}'))))`)
        .bind(input.commandId, task.id, command, at, JSON.stringify(predecessor || {}), task.id, task.epoch, task.status, task.revision, task.updated_at, input.commandId, command),
      env.DB.prepare(`update agent_tasks set pending_command_id=? where id=? and epoch=? and status=? and (pending_command_id='' or pending_command_id=? or
        (?='cancel' and not exists(select 1 from agent_runtime_commands where command_id=pending_command_id and command='cancel' and receipt_json='{}')))
        and exists(select 1 from agent_runtime_commands where command_id=?)`).bind(input.commandId, task.id, task.epoch, task.status, input.commandId, command, input.commandId),
    ]);
    if (!result[1].meta.changes) throw new Error('Another task command is being processed');
  }
  if (command === 'cancel') {
    await cancelTaskTree(env, task, input, at);
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
