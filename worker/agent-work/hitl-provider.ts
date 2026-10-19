import { createHitlResponse, type HitlSpec } from '../../shared/hitl';
import type { WorkNode } from '../../shared/agent-work';
import { taskForRun } from '../agent-runtime/task-store';
import { executeTaskCommand } from '../agent-runtime/task-commands';
import { getAgentRun } from '../agent-runtime/store';
import type { WorkProvider } from './contracts';

/** A composed request only collects input. The resumed Agent still owns every business decision. */
export const hitlWorkProvider: WorkProvider = {
  id: 'hitl',
  async respond(env, context, input, actorId) {
    const saved = await context.db.prepare(`select r.node_json from agent_work_requests r join agent_tasks t on t.id=r.task_id
      where r.task_id=? and r.request_id=? and r.version=? and r.handler_id='hitl' and t.workspace_id=? and t.site_id=? and t.agent_id=?`)
      .bind(context.task.id, input.request_id, input.version, context.workspaceId, context.siteId, context.task.agent_id).first<{ node_json: string }>();
    if (!saved) throw new Error('The HITL request no longer exists');
    const node = JSON.parse(saved.node_json) as WorkNode;
    const spec = node.interaction?.spec as HitlSpec | undefined;
    if (!spec) throw new Error('The HITL request is missing a content definition');
    const response = createHitlResponse({ id: input.request_id, version: input.version, spec }, input.action, input.values);
    const sorted = (values: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
    if (sorted(response.values) !== sorted(input.values)) throw new Error('Contains input fields that are currently invisible');
    const value = JSON.stringify({ type: 'hitl_response', ...response });
    if (value.length > 20_000) throw new Error('The HITL response is too long');
    const task = await taskForRun(env.DB, context.task.active_run_id);
    if (!task || ['completed', 'cancelled'].includes(task.status)) return { message: 'The task has ended or been canceled; this response will not resume execution.', outcome: 'superseded' };
    const previous = await env.DB.prepare('select 1 from agent_runtime_commands where command_id=?').bind(input.command_id).first();
    if (!previous && task.status !== 'waiting') return { message: 'The task status has changed; this response was not executed.', outcome: 'superseded' };
    const run = await getAgentRun(env.DB, task.active_run_id);
    if (!run) throw new Error('The Run the task belongs to no longer exists');
    await executeTaskCommand(env, { run, command: 'provide_input', commandId: input.command_id, actorId, reason: '', value,
      expectedTask: `${task.epoch}:${task.revision}:${task.updated_at}` });
    return { message: 'Response saved; the Agent will continue in the original task.' };
  },
};
