import type { WorkProvider } from './contracts';
import { executeTaskCommand } from '../agent-runtime/task-commands';
import { getAgentRun } from '../agent-runtime/store';

export const runtimeWorkProvider: WorkProvider = {
  id: 'runtime',
  // Runtime recovery is automatic. Keep the handler so previously submitted
  // responses can be reconciled without creating new human work requests.
  async pending() { return []; },
  async read() { return []; },
  async respond(env, { task }, input, actorId) {
    const run = await getAgentRun(env.DB, task.active_run_id);
    if (!run) throw new Error('Task no longer exists');
    const prior = await env.DB.prepare('select command_id from agent_runtime_commands where command_id=?').bind(input.command_id).first();
    if (['completed', 'cancelled'].includes(task.status)) return { message: 'Task has ended or been canceled; the saved response will be kept and execution will not be resumed.', outcome: 'superseded' };
    if (!prior && input.version !== `${task.epoch}:${task.revision}:${task.updated_at}`) return { message: 'Task has changed, this response was not executed. Please check the latest work status.', outcome: 'superseded' };
    await executeTaskCommand(env, { run, command: input.action, commandId: input.command_id, actorId,
      reason: '', value: input.values.value, expectedTask: input.version });
    return { message: input.action === 'provide_input' ? 'Supplementary information has been saved, the task continues.' : 'Task has resumed execution.' };
  },
};
