import { settleRuntimeCheckpoint } from './runtime-checkpoint';
import { authorityForExecution } from './runtime-executions';
import type { D1Database } from '@cloudflare/workers-types';
import type { RuntimeAgentEnv } from './env';
import { type AgentTask, taskResumeBlock, taskForRun, taskDataJson, taskHasClosedAncestor } from './task-store';
import { type ExecutionFailure } from './execution-failure';
import { currentExecution, dispatchExecution, recoverExecution, type RuntimeExecution } from './runtime-executions';
import { disposeRpcResource } from './rpc-resource';

export async function recordExecutionFailure(env: RuntimeAgentEnv, runId: string, failure: ExecutionFailure, now = new Date()) {
  const execution = await currentExecution(env.DB, runId);
  if (!execution || !['running','dispatching'].includes(execution.status) || (env.execution && env.execution.executionId !== execution.id)) return;
  if (failure.recovery_action === 'pause') {
    await env.DB.batch([
      env.DB.prepare("update agent_runs set phase='paused',execution_failure_json=?,execution_outcome='execution_failed',updated_at=? where id=?").bind(taskDataJson(failure),now.toISOString(),runId),
      env.DB.prepare("update agent_tasks set status='paused',outcome='execution_failed',reason=?,updated_at=? where execution_id=? and epoch=? and status='running'").bind(failure.message,now.toISOString(),execution.id,execution.epoch),
      env.DB.prepare("update agent_runtime_executions set status='waiting',error_json=?,reason=?,updated_at=? where id=? and epoch=?").bind(taskDataJson(failure),failure.message,now.toISOString(),execution.id,execution.epoch),
    ]);
    return;
  }
  const next = new Date(now.getTime() + (failure.scope === 'account' ? 300_000 : 60_000)).toISOString();
  // A single transaction revokes the execution and publishes its durable backoff.
  await env.DB.batch([
    env.DB.prepare(`update agent_runs set phase='recovering',execution_failure_json=?,execution_outcome='recovering',updated_at=? where id=?
      and exists(select 1 from agent_tasks where execution_id=? and status not in ('completed','cancelled'))`)
      .bind(taskDataJson(failure), now.toISOString(), runId, execution.id),
    env.DB.prepare(`update agent_tasks set status='running',outcome='execution_recovering',reason=?,updated_at=?
      where execution_id=? and epoch=? and status not in ('completed','cancelled')`).bind(failure.message, now.toISOString(), execution.id, execution.epoch),
    env.DB.prepare(`update agent_runtime_executions set status='recovering',error_json=?,reason=?,retry_at=?,updated_at=? where id=? and epoch=? and status in ('running','recovering')`)
      .bind(taskDataJson(failure), failure.message, next, now.toISOString(), execution.id, execution.epoch),
  ]);
}

export async function taskExecutionView(db: D1Database, task: AgentTask) {
  const execution = await currentExecution(db, task.active_run_id);
  const recovering = execution?.status === 'recovering' || execution?.status === 'dispatching';
  const block = await taskResumeBlock(db, task);
  const ancestorClosed = await taskHasClosedAncestor(db, task.id);
  return { execution_state: recovering ? 'recovering' : task.status,
    execution_id: execution?.id || '', epoch: execution?.epoch || task.epoch,
    recovery_reason: recovering ? execution?.reason || '' : '', next_recovery_at: recovering ? execution?.retry_at || '' : '',
    allowed_actions: ancestorClosed || ['completed','cancelled'].includes(task.status) ? [] : recovering || task.status === 'running' ? ['cancel']
      : block ? ['cancel'] : task.status === 'waiting' ? ['resume','provide_input','cancel'] : ['resume','cancel'] };
}

async function workflowState(env: RuntimeAgentEnv, id: string) {
  const instance = await env.AGENT_WORKFLOW.get(id);
  try { return await instance.status(); } finally { disposeRpcResource(instance); }
}

export async function settleClosedHostRequests(db: D1Database, taskId: string, runId: string, now: Date) {
  // Preserve accounting and payloads. A closed host proves only that no receipt
  // can arrive, not whether the provider completed or charged the request.
  await db.batch([
    db.prepare(`update agent_model_attempts set status='failed',error_kind='outcome_unknown',
      error='Execution host closed before the model response receipt was saved',finished_at=?
      where run_id=? and status='running' and exists(select 1 from agent_task_model_reservations m
        where m.task_id=? and m.status='running' and substr(agent_model_attempts.purpose,-length(m.id)-2)='::'||m.id)`)
      .bind(now.toISOString(),runId,taskId),
    db.prepare("update agent_task_model_reservations set status='failed',outcome_state='unknown' where task_id=? and status='running'").bind(taskId),
  ]);
}

/** Execution recovery makes no domain progress/stall judgment and has no lifetime retry limit. */
export async function reconcileTaskExecutions(env: RuntimeAgentEnv, now = new Date()) {
  if (env.AGENT_RUNTIME_ENABLED !== 'true') return;
  const rows = await env.DB.prepare(`select e.* from agent_runtime_executions e join agent_tasks t on t.execution_id=e.id
    where (e.status in ('running','dispatching','recovering') or (e.status='waiting' and t.status='paused'
      and exists(select 1 from agent_task_model_reservations m where m.task_id=t.id and m.status='running')))
    and e.retry_at<=? order by e.updated_at limit 20`).bind(now.toISOString()).all<RuntimeExecution>();
  for (const execution of rows.results) {
    try {
      if (execution.status === 'waiting') {
        const state = await workflowState(env, execution.workflow_id);
        if (!['errored','terminated','complete'].includes(state.status)) continue;
        // The old host is definitively closed. Retain its unknown generation and
        // reserved usage; recovery allocates a different physical request.
        await settleClosedHostRequests(env.DB, execution.task_id, execution.run_id, now);
        const task = await taskForRun(env.DB, execution.run_id);
        if (!task || await taskResumeBlock(env.DB, task)) continue;
        await recoverExecution(env, execution, 'closed_host_model_receipt_missing');
        continue;
      }
      const checkpoint = await settleRuntimeCheckpoint(env, authorityForExecution(execution));
      if (checkpoint) continue;
      if (execution.status === 'dispatching') { await dispatchExecution(env, execution); continue; }
      const state = await workflowState(env, execution.workflow_id);
      if (!['errored','terminated','complete'].includes(state.status)) {
        await env.DB.prepare('update agent_runtime_executions set updated_at=? where id=?').bind(now.toISOString(), execution.id).run();
        continue;
      }
      const task = await taskForRun(env.DB, execution.run_id);
      if (!task || task.execution_id !== execution.id || ['completed','cancelled'].includes(task.status)) continue;
      // A terminated host cannot commit another model response. Preserve the lost
      // physical request and charge; a new request gets a different execution ID.
      await settleClosedHostRequests(env.DB, task.id, execution.run_id, now);
      const block = await taskResumeBlock(env.DB, task);
      if (block) {
        await env.DB.prepare(`update agent_tasks set status='paused',outcome='external_pending',reason=?,updated_at=? where id=? and execution_id=?`)
          .bind(block, now.toISOString(), task.id, execution.id).run();
        await env.DB.prepare("update agent_runtime_executions set status='waiting',reason=?,updated_at=? where id=?")
          .bind(block, now.toISOString(), execution.id).run();
        continue;
      }
      await recoverExecution(env, execution, state.error?.message || execution.reason || 'host_recovery');
    } catch (error) {
      await env.DB.prepare('update agent_runtime_executions set retry_at=?,updated_at=?,error_json=? where id=?')
        .bind(new Date(now.getTime() + 60_000).toISOString(), now.toISOString(), taskDataJson({ error: String(error) }), execution.id).run();
    }
  }
}
