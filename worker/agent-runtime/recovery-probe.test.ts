import { describe, expect, it } from 'vitest';
import { taskTestDb, resumeTestTask } from './task-test-db';
import { agentDefinition } from './definitions';
import { taskForRun } from './task-store';
import { recordExecutionFailure } from './task-recovery';
import { executionFailure } from './execution-failure';
import { runRecoveryProbe } from './recovery-probe';
import type { AgentModuleExecutionContext } from './agent-modules';
describe('synthetic recovery acceptance contract', () => {
  it('returns a schema-valid final result and reuses the first checkpoint receipt', async () => {
    const f = taskTestDb(); const first = f.run(); const definition = agentDefinition('runtime_synthetic');
    const env = {DB: f.db} as AgentModuleExecutionContext['env'];
    const step = {do: async (_name: string, config: unknown, action?: () => Promise<unknown>) => (action || config as () => Promise<unknown>)()} as AgentModuleExecutionContext['step'];
    const context = {env,step,run:first,definition,snapshotId:'fixture'} as AgentModuleExecutionContext;
    let failure;
    try { await runRecoveryProbe(context); } catch (error) { failure = executionFailure(error); }
    expect(failure?.recovery_action).toBe('new_execution');
    await recordExecutionFailure(env, first.id, failure!);
    await resumeTestTask(f.db,first.id);
    const next=first;
    const result = await runRecoveryProbe({...context,run:next});
    expect(definition.outputSchema.safeParse(result.output).success).toBe(true);
    expect(await taskForRun(f.db,next.id)).toMatchObject({status:'completed',revision:1,model_calls:0});
  });
});
