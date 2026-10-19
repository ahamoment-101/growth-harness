import { expect, it } from 'vitest';
import { taskTestDb } from './task-test-db';
import { attachTask, stopTask } from './task-store';
import { agentDefinition } from './definitions';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution } from './runtime-executions';
import { settleRuntimeCheckpoint } from './runtime-checkpoint';
import type { RuntimeAgentEnv } from './env';

it.each(['waiting', 'paused'] as const)('projects %s without turning an execution interruption into a business input request', async status => {
  const fixture = taskTestDb();
  const task = await attachTask(fixture.db, fixture.run(), agentDefinition('strategy_research'));
  const execution = await createRuntimeExecution(fixture.db, task.active_run_id);
  const authority = authorityForExecution(execution);
  await activateRuntimeExecution(fixture.db, authority, execution.workflow_id);
  await stopTask(fixture.db, task.active_run_id, status, 'Saved checkpoint', status === 'waiting' ? 'business_waiting' : 'execution_failed');
  await settleRuntimeCheckpoint({ DB: fixture.db } as RuntimeAgentEnv, authority);
  const run = await fixture.db.prepare('select status,phase,finished_at from agent_runs where id=?').bind(task.active_run_id).first();
  expect(run).toMatchObject({ status: status === 'waiting' ? 'waiting_for_input' : 'running', phase: status, finished_at: '' });
  const events = await fixture.db.prepare('select kind from agent_events where run_id=?').bind(task.active_run_id).all<{ kind: string }>();
  expect(events.results.map(event => event.kind)).toContain(status === 'waiting' ? 'input_requested' : 'execution_paused');
  if (status === 'paused') expect(events.results.map(event => event.kind)).not.toContain('input_requested');
});
