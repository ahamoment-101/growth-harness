import { appendAgentEvent } from './store';
import type { AgentModuleExecutionContext } from './agent-modules';
import { attachTask, beginTaskDecision, writeTaskWorkspace, stopTask } from './task-store';
import { encodeExecution, decodeExecution } from './execution-failure';

// Only used by the explicitly invoked synthetic verification Agent. No model,
// search request or user business artifact is produced by this fixture.
export async function runRecoveryProbe(context: AgentModuleExecutionContext) {
  const { env, run, definition, step } = context;
  const task = await attachTask(env.DB, run, definition);
  const operation = await beginTaskDecision(env.DB, task, { fixture: 'execution-recovery' });
  const receipt = await step.do('recovery-probe-checkpoint', () => writeTaskWorkspace(env.DB, task, operation, task.revision, { fixture: 'saved-once' }));
  if (task.epoch === 1) {
    decodeExecution(await step.do('recovery-probe-native-fault', { retries: {limit: 0, delay: '1 second'}, timeout: '10 seconds' }, () => encodeExecution(async () => {
      throw new Error('Too many API requests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits');
    }, 'synthetic_platform_boundary')));
  }
  const event = await step.do('recovery-probe-complete-event', () => appendAgentEvent(env.DB, {
    runId: run.id, eventKey: 'recovery.verified', kind: 'tool_completed', phase: 'verification', actorType: 'tool', payload: { revision: receipt.revision },
  }));
  await stopTask(env.DB, run.id, 'completed', 'Synthetic recovery verified', 'completed', { revision: receipt.revision });
  return { output: {durable: true, context_snapshot_id: context.snapshotId, eventSeq: event.seq}, phase: 'completed' };
}
