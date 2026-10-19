import { runtimeAgentModule } from './agent-modules';
import type { AgentId } from './definitions';
import { persistRuntimeJson } from './runtime-content';
import type { RuntimeAgentEnv } from './env';
import type { RuntimeExecutionContext } from './execution-context';
import { taskForRun } from './task-store';
import { appendAgentEvent } from './store';
import { closeDescendantSessions } from './task-descendants';
import { notifyParentRunFinished } from './child-run-wait';

/** Controller projection of an already committed business checkpoint. Never runs business effects. */
export async function settleRuntimeCheckpoint(env: RuntimeAgentEnv, authority: RuntimeExecutionContext) {
  const task = await taskForRun(env.DB, authority.runId);
  if (!task || task.id !== authority.taskId || task.execution_id !== authority.executionId || task.epoch !== authority.epoch || task.status === 'running') return null;
  const projectedCheckpoint = await runtimeAgentModule(task.agent_id as AgentId).settleCheckpoint?.(env, authority);
  if (projectedCheckpoint) return projectedCheckpoint;
  const terminal = ['completed','failed','cancelled'].includes(task.status);
  // Run status remains a compatibility projection. Only a business waiting
  // checkpoint requests input; a paused execution must not invent that request.
  const status = task.status === 'completed' ? 'succeeded' : task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled' : task.status === 'waiting' ? 'waiting_for_input' : 'running';
  const at = new Date().toISOString();
  const gate = `exists(select 1 from agent_tasks where id=? and active_run_id=? and execution_id=? and epoch=? and status=?)`;
  const bindings = [task.id, authority.runId, authority.executionId, authority.epoch, task.status];
  await env.DB.prepare(`update agent_model_attempts set status='failed',error_kind='outcome_unknown',
    error='Execution host closed before the model response receipt was saved',finished_at=?
    where run_id=? and status='running' and exists(select 1 from agent_task_model_reservations m
      where m.task_id=? and m.status='failed' and m.outcome_state='unknown'
      and substr(agent_model_attempts.purpose,-length(m.id)-2)='::'||m.id) and ${gate}`)
    .bind(at,authority.runId,task.id,...bindings).run();
  // A parent may already have projected this terminal child while closing its
  // hosts. Replaying either checkpoint must retain the first terminal timestamp.
  const projected = await env.DB.prepare(`update agent_runs set status=?,phase=?,output_json=?,execution_outcome=?,
    finished_at=case when ? and finished_at!='' then finished_at else ? end,
    updated_at=case when ? and finished_at!='' then updated_at else ? end where id=? and ${gate}`)
    .bind(status,task.outcome==='parent_closed'?'parent_closed':task.status,
      await persistRuntimeJson(env.DB, JSON.parse(task.output_json)),task.outcome,terminal?1:0,terminal?at:'',terminal?1:0,at,authority.runId,...bindings).run();
  if (!projected.meta.changes) return null;
  await appendAgentEvent(env.DB,{runId:authority.runId,eventKey:`execution:${authority.epoch}:checkpoint`,
    kind:task.status==='failed'?'run_failed':task.status==='cancelled'?'run_cancelled':terminal?'run_succeeded':task.status==='waiting'?'input_requested':'execution_paused',
    phase:task.status,actorType:'workflow',payload:{outcome:task.outcome,reason:task.reason,output_ref:`task:${task.id}`}});
  if (terminal) await closeDescendantSessions(env,authority);
  await notifyParentRunFinished(env,authority.runId);
  try { await runtimeAgentModule(task.agent_id as AgentId).afterCheckpoint?.(env, authority); }
  catch (error) { console.error('Agent event dispatch pending', authority.runId, String(error)); }
  // Last step: the recovery scanner keeps seeing the checkpoint until projection,
  // descendant cleanup, and parent notification have all completed.
  await env.DB.prepare(`update agent_runtime_executions set status=?,updated_at=? where id=? and ${gate}`)
    .bind(terminal?'finished':'waiting',at,authority.executionId,...bindings).run();
  return {task_id:task.id,run_id:authority.runId,execution_id:authority.executionId,status:task.status,output_ref:`task:${task.id}`};
}
