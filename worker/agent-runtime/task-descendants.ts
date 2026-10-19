import type { RuntimeAgentEnv } from './env';
import type { RuntimeExecutionContext } from './execution-context';
import type { AgentRun } from './protocol';
import { runtimeAgentModule } from './agent-modules';
import type { AgentId } from './definitions';
import { disposeRpcResource } from './rpc-resource';

/** Controller cleanup after the ancestor barrier, never a grant to child executors. */
export async function closeDescendantSessions(env: RuntimeAgentEnv, authority: RuntimeExecutionContext) {
  const gate = "exists(select 1 from agent_tasks where id=? and active_run_id=? and execution_id=? and epoch=? and status in ('completed','failed','cancelled'))";
  const bindings = [authority.taskId, authority.runId, authority.executionId, authority.epoch];
  const parent = await env.DB.prepare(`select 1 where ${gate}`).bind(...bindings).first();
  if (!parent) return;
  await env.DB.prepare(`with recursive descendants(id) as (
    select id from agent_tasks where parent_task_id=? union all select t.id from agent_tasks t join descendants p on t.parent_task_id=p.id)
    update agent_tasks set status=case when status='waiting' then 'completed' else 'cancelled' end,
      outcome=case when status='waiting' then 'parent_closed' else 'cancelled' end,reason='Parent task closed',updated_at=?
    where id in (select id from descendants) and status in ('running','waiting','paused') and ${gate}`)
    .bind(authority.taskId,new Date().toISOString(),...bindings).run();
  const runs = await env.DB.prepare(`with recursive descendants(id) as (
    select id from agent_tasks where parent_task_id=? union all select t.id from agent_tasks t join descendants p on t.parent_task_id=p.id)
    select r.*,t.status as task_status,t.outcome as task_outcome,t.updated_at as task_updated_at,t.output_json as task_output_json
    from agent_runs r join agent_tasks t on t.active_run_id=r.id
    where t.id in(select id from descendants) and t.status in ('completed','failed','cancelled')
      and (t.status!='completed' or t.outcome='parent_closed' or r.status not in ('succeeded','failed','cancelled')
        or exists(select 1 from agent_runtime_executions e where e.run_id=r.id and e.status not in ('finished','superseded','cancelled')))
      and ${gate}`)
    .bind(authority.taskId,...bindings).all<AgentRun & {task_status:string;task_outcome:string;task_updated_at:string;task_output_json:string}>();
  for (const run of runs.results) {
    // A child can commit its Task before its own checkpoint projects the Run.
    // Complete that projection, but never rewrite an existing terminal receipt.
    await env.DB.prepare(`update agent_runs set status=?,phase=?,execution_outcome=?,output_json=?,finished_at=?,updated_at=?
      where id=? and status not in ('succeeded','failed','cancelled') and ${gate}`)
      .bind(run.task_status==='completed'?'succeeded':run.task_status,
        run.task_outcome==='parent_closed'?'parent_closed':run.task_status,run.task_outcome,run.task_output_json,
        run.task_updated_at,run.task_updated_at,run.id,...bindings).run();
    await env.DB.prepare(`update agent_runtime_executions set status='cancelled' where run_id=?
      and status not in ('finished','superseded','cancelled') and ${gate}`).bind(run.id,...bindings).run();
    // Closing a host and reconciling external effects must not depend on rewriting
    // a failed business outcome to cancelled. Provider receipts decide what is due.
    if (!(await env.DB.prepare(`select 1 where ${gate}`).bind(...bindings).first())) return;
    if(run.task_status!=='completed') try { await runtimeAgentModule(run.agent_id as AgentId).onCancel?.(env,run); } catch { /* External cancellation sweep retains its receipt. */ }
    if(run.workflow_id) try {
      const instance=await env.AGENT_WORKFLOW.get(run.workflow_id);
      try { await instance.terminate(); } finally { disposeRpcResource(instance); }
    } catch { /* Descendant writes are already fenced by the parent terminal state. */ }
  }
}
