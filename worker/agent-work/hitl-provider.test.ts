import { expect, it, vi } from 'vitest';
import { agentDefinition } from '../agent-runtime/definitions';
import { strategyTaskTools } from '../agent-runtime/strategy-task';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { attachTask, beginTaskDecision, stopTask, taskForRun } from '../agent-runtime/task-store';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import type { WorkResponse } from '../../shared/agent-work';
import { respondToWork, workInteractions, pendingWork } from './index';
import { hitlWorkProvider } from './hitl-provider';
import { runtimeWorkProvider } from './runtime-provider';

const spec = {
  schema_version: 1 as const, title: 'Confirm target market', description: 'The existing business materials do not specify the target market for this round.',
  blocks: [
    { type: 'text' as const, text: 'Please select the market to prioritize researching this time.' },
    { type: 'choice' as const, id: 'market', label: 'Target market', required: true, options: [
      { value: 'us', label: 'United States' }, { value: 'uk', label: 'United Kingdom' },
    ] },
    { type: 'textarea' as const, id: 'context', label: 'Additional context', max_length: 500 },
  ],
  actions: [{ id: 'submit', label: 'Submit message', tone: 'primary' as const, required_fields: ['market'] }],
};

it('persists an Agent-composed request and resumes the same Task and Run from a structured response', async () => {
  const f = taskTestDb();
  const run = f.run();
  const task = await attachTask(f.db, run, agentDefinition('strategy_research'));
  const operation = await beginTaskDecision(f.db, task, {});
  const definition = agentDefinition('strategy_research');
  const registry = strategyTaskTools({ env: { DB: f.db } as RuntimeAgentEnv, definition, task, operation, runId: run.id, locale: 'en' });
  const args = { spec, resume_when: 'Continue research after receiving market information' };
  const context = { runId: run.id, workspaceId: task.workspace_id, siteId: task.site_id, idempotencyKey: operation.id };
  const output = await registry.execute(definition, 'request_human_input', args, context) as { request_id: string; title: string };
  expect(output).toEqual({ request_id: `hitl:${operation.id}`, title: spec.title, resume_when: args.resume_when });
  expect(await registry.execute(definition, 'request_human_input', args, context)).toEqual(output);
  await stopTask(f.db, run.id, 'waiting', 'Waiting for user response');
  const current = (await taskForRun(f.db, run.id))!;
  const requestContext = { db: f.db as unknown as D1Database, workspaceId: task.workspace_id, siteId: task.site_id, task: current };
  expect((await workInteractions(requestContext, [hitlWorkProvider, runtimeWorkProvider])).filter(node => node.interaction?.state === 'pending')).toMatchObject([
    { title: spec.title, interaction: { spec } },
  ]);
  expect(await pendingWork(requestContext, task.agent_id, [hitlWorkProvider, runtimeWorkProvider])).toHaveLength(1);
  const response: WorkResponse = { request_id: output.request_id, version: '1', action: 'submit', values: { market: 'us', context: 'Serving US clients' }, command_id: 'hitl-test-1' };
  const create = vi.fn().mockRejectedValueOnce(new Error('Lost dispatch')).mockResolvedValue({ id: 'accepted' });
  const env = { DB: f.db, AGENT_RUNTIME_ENABLED: 'true', AGENT_WORKFLOW: { create, get: async () => { throw new Error('unavailable'); } } } as unknown as RuntimeAgentEnv;
  await expect(respondToWork(env, requestContext, response, 'user-1', [hitlWorkProvider])).rejects.toThrow('Lost dispatch');
  expect((await workInteractions(requestContext, [hitlWorkProvider])).some(node => node.interaction?.pending_submission?.command_id === response.command_id)).toBe(true);
  const receipt = await respondToWork(env, requestContext, response, 'user-1', [hitlWorkProvider]);
  expect(receipt.message).toContain('original task');
  expect(await respondToWork(env, requestContext, response, 'user-1', [hitlWorkProvider])).toEqual(receipt);
  expect(f.sqlite.prepare('select count(*) as n from agent_runs').get()).toEqual({ n: 1 });
  expect(f.sqlite.prepare('select count(*) as n from agent_task_inputs').get()).toEqual({ n: 1 });
  const input = f.sqlite.prepare('select content from agent_task_inputs').get() as { content: string };
  expect(JSON.parse(input.content)).toEqual({ type: 'hitl_response', request_id: output.request_id, version: '1', action: 'submit', values: response.values });
  expect((await workInteractions(requestContext, [hitlWorkProvider])).some(node => node.interaction?.state === 'resolved')).toBe(true);
  expect(create).toHaveBeenCalledTimes(2);
});

it('rejects hidden input and keeps older strategy task tool manifests unchanged', async () => {
  const f = taskTestDb();
  const run = f.run();
  const task = await attachTask(f.db, run, agentDefinition('strategy_research'));
  const operation = await beginTaskDecision(f.db, task, {});
  const definition = agentDefinition('strategy_research');
  const registry = strategyTaskTools({ env: { DB: f.db } as RuntimeAgentEnv, definition, task, operation, runId: run.id, locale: 'en' });
  const context = { runId: run.id, workspaceId: task.workspace_id, siteId: task.site_id, idempotencyKey: operation.id };
  const output = await registry.execute(definition, 'request_human_input', { spec: {
    ...spec, blocks: [...spec.blocks, { type: 'textarea', id: 'reason', label: 'Reason', show_when: { field: 'market', equals: 'uk' } }],
  }, resume_when: 'Continue' }, context) as { request_id: string };
  await stopTask(f.db, run.id, 'waiting', 'Waiting for user response');
  const current = (await taskForRun(f.db, run.id))!;
  const requestContext = { db: f.db as unknown as D1Database, workspaceId: task.workspace_id, siteId: task.site_id, task: current };
  const input: WorkResponse = { request_id: output.request_id, version: '1', action: 'submit', values: { market: 'us', reason: 'Hidden' }, command_id: 'invalid-hitl' };
  await expect(respondToWork({ DB: f.db } as RuntimeAgentEnv, requestContext, input, 'user-1', [hitlWorkProvider])).rejects.toThrow('invisible');
  expect(f.sqlite.prepare('select count(*) as n from agent_task_inputs').get()).toEqual({ n: 0 });
  f.sqlite.prepare('update agent_tasks set definition_version=38 where id=?').run(task.id);
  const old = (await taskForRun(f.db, run.id))!;
  expect(strategyTaskTools({ env: { DB: f.db } as RuntimeAgentEnv, definition, task: old, operation, runId: run.id, locale: 'en' }).names()).not.toContain('request_human_input');
});
