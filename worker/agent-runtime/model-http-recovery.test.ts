import { afterEach, expect, it, vi } from 'vitest';
import { taskTestDb } from './task-test-db';
import { attachTask } from './task-store';
import { agentDefinition } from './definitions';
import { conversationChannel } from './conversation-channel';
import { requestConversationModel } from './conversation-request';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { testModelProfile } from './model-registry.test-fixture';
import { faultAwareStep } from './platform-step';

afterEach(() => vi.unstubAllGlobals());
it.each([429, 503, 524, 401, 403, 400])('retains HTTP %s in recovery routing after saving its model receipt and a Workflow boundary', async status => {
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const env = { DB: f.db, execution: {
    taskId: task.id, runId: task.active_run_id, executionId: 'execution-1', epoch: 1,
  } } as RuntimeAgentEnv;
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Synthetic provider failure' } }),
    { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const channel = conversationChannel(testModelProfile({ model: 'fixture', contextWindow: 10000,
    maxOutputTokens: 2000, reasoningSupported: false }));
  const step = faultAwareStep({ do: async (_key: string, _config: unknown, fn: () => Promise<unknown>) => {
    try { return JSON.parse(JSON.stringify(await fn())); }
    catch (error) { throw new Error(String(error)); }
  } } as RuntimeWorkflowStep);
  await expect(requestConversationModel({ env, runId: task.active_run_id, decisionId: 'request-1', purpose: 'context_compaction', turn: 1,
    step,
    context: { messages: [{ role: 'user', timestamp: 0, content: 'Synthetic input' }] },
    model: channel.model, stream: channel.stream, maxTokens: 2000 })).rejects.toMatchObject({
      failure: { status, recovery_action: status === 400 ? 'pause' : status === 401 || status === 403 ? 'new_execution' : 'retry_request', origin: 'upstream' },
    });
  expect(fetch).toHaveBeenCalledTimes(1);
  const receipt = await f.db.prepare('select status,response_json from agent_task_model_reservations').first<{status:string;response_json:string}>();
  expect(receipt?.status).toBe('succeeded');
  expect(JSON.parse(receipt!.response_json).stopReason).toBe('error');
  expect(JSON.parse(receipt!.response_json).runtimeFailure).toBe('execution_failure');
  if (status === 524) {
    env.execution = { taskId: task.id, runId: task.active_run_id, executionId: 'execution-2', epoch: 2 };
    await expect(requestConversationModel({ env, runId: task.active_run_id, decisionId: 'request-1', purpose: 'context_compaction', turn: 1,
      step, context: { messages: [{ role: 'user', timestamp: 0, content: 'Synthetic input' }] },
      model: channel.model, stream: channel.stream, maxTokens: 2000 })).rejects.toMatchObject({
      failure: { status: 524, recovery_action: 'retry_request', origin: 'upstream' },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await f.db.prepare('select count(*) as n from agent_task_model_reservations').first('n')).toBe(2);
  }
});
