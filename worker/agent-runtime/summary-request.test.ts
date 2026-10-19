import { expect, it } from 'vitest';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { fitDurableSummary, summarizeDurably, summaryFragments } from './summary-request';
import { taskTestDb } from './task-test-db';
import { attachTask } from './task-store';
import { agentDefinition } from './definitions';
import { replayConversationResponse } from './conversation-replay';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution, ExecutionHandoff } from './runtime-executions';
import { executionEnvironment } from './execution-context';
import { executionStep } from './execution-step';

it('repairs truncated output after host interruption with full original material and reuses both receipts', async () => {
  const fixture = taskTestDb();
  const task = await attachTask(fixture.db, fixture.run(), agentDefinition('strategy_research'));
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture',
    baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 2000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const material = 'Target 🙂 Entity A completed; Entity B pending';
  const calls: string[] = [];
  let interrupt = true;
  const step = { do: async (key: string, _config: unknown, fn: () => Promise<unknown>) => {
    if (key.endsWith(':repair:1') && interrupt) { interrupt = false; throw new Error('host interrupted before request'); }
    return fn();
  } } as RuntimeWorkflowStep;
  const stream: StreamFn = (selectedModel, context, options) => {
    const text = String(context.messages[0].content);
    calls.push(text);
    expect(options?.maxTokens).toBe(model.maxTokens);
    const response: AssistantMessage = { role: 'assistant', api: selectedModel.api, provider: selectedModel.provider,
      model: selectedModel.id, timestamp: 0, stopReason: calls.length === 1 ? 'length' : 'stop',
      content: [{ type: 'text', text }], usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return replayConversationResponse(response, stream)(selectedModel, context, options);
  };
  const input = { env: { DB: fixture.db } as RuntimeAgentEnv, step, runId: task.active_run_id,
    key: 'summary', turn: 1, instructions: 'Keep entities and pending work.', material, model, stream };
  await expect(summarizeDurably(input)).rejects.toThrow('host interrupted');
  expect(calls).toHaveLength(1);
  const result = await summarizeDurably(input);
  expect(result.replace('\n\n', '')).toBe(material);
  expect(calls).toHaveLength(2);
  expect(calls).toEqual([material, material]);
  expect(await summarizeDurably(input)).toBe(result);
  expect(calls).toHaveLength(2);
  expect(fixture.sqlite.prepare('select count(*) as count from agent_runs').get()).toEqual({ count: 1 });
});

it('feeds back a non-reducing result, persists successive reductions and reuses them on replay', async () => {
  const fixture = taskTestDb();
  const task = await attachTask(fixture.db, fixture.run(), agentDefinition('strategy_research'));
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture',
    baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 2000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let calls = 0;
  const instructions: string[] = [];
  const stream: StreamFn = (selectedModel, context, options) => {
    calls++;
    instructions.push(context.systemPrompt || '');
    const text = String(context.messages[0].content);
    const response: AssistantMessage = { role: 'assistant', api: selectedModel.api, provider: selectedModel.provider,
      model: selectedModel.id, timestamp: 0, stopReason: 'stop',
      content: [{ type: 'text', text: calls === 1 ? text : text.slice(0, text.length / 2) }],
      usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return replayConversationResponse(response, stream)(selectedModel, context, options);
  };
  const input = { env: { DB: fixture.db } as RuntimeAgentEnv,
    step: { do: async (_key: string, _config: unknown, fn: () => Promise<unknown>) => fn() } as RuntimeWorkflowStep,
    runId: task.active_run_id, key: 'reduce-summary', turn: 1, instructions: 'Consolidate summary.',
    material: 'a'.repeat(800), model, stream, targetTokens: 40, fits: (text: string) => text.length <= 100 };
  expect(await fitDurableSummary(input)).toHaveLength(100);
  expect(calls).toBe(4);
  expect(instructions[1]).toContain('Capacity feedback after reduction 1');
  expect(instructions[1]).toContain('The supplied source is unchanged');
  expect(await fitDurableSummary(input)).toHaveLength(100);
  expect(calls).toBe(4);
});

it('hands off a full host during reduction and continues the same Run with saved rejection feedback', async () => {
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const first = await createRuntimeExecution(f.db, task.active_run_id);
  await activateRuntimeExecution(f.db, authorityForExecution(first), first.workflow_id);
  const base = { DB: f.db } as RuntimeAgentEnv;
  const env = executionEnvironment(base, authorityForExecution(first));
  const step = { do: async (_key: string, _config: unknown, fn: () => Promise<unknown>) => fn() } as RuntimeWorkflowStep;
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture',
    baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 2000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const prompts: string[] = [];
  const stream: StreamFn = (selectedModel, context, options) => {
    prompts.push(context.systemPrompt || '');
    const response: AssistantMessage = { role: 'assistant', api: selectedModel.api, provider: selectedModel.provider,
      model: selectedModel.id, timestamp: 0, stopReason: 'stop',
      content: [{ type: 'text', text: prompts.length === 1 ? String(context.messages[0].content) : 'Entity ref-1, observed v7, saved. Next: verify.' }],
      usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return replayConversationResponse(response, stream)(selectedModel, context, options);
  };
  const input = { env, step: executionStep(step, env), runId: task.active_run_id, key: 'host-summary', turn: 1,
    instructions: 'Keep exact entities and effects.', material: 'Entity ref-1, observed v7, saved. Next: verify. '.repeat(20),
    model, stream, targetTokens: 40, fits: (text: string) => text.length <= 100 };
  await f.db.prepare('update agent_runtime_executions set durable_steps=199 where id=?').bind(first.id).run();
  await expect(fitDurableSummary(input)).rejects.toBeInstanceOf(ExecutionHandoff);
  expect(prompts).toHaveLength(1);
  const second = await createRuntimeExecution(f.db, task.active_run_id, first, 'workflow_capacity');
  await activateRuntimeExecution(f.db, authorityForExecution(second), second.workflow_id);
  const nextEnv = executionEnvironment(base, authorityForExecution(second));
  expect(await fitDurableSummary({ ...input, env: nextEnv, step: executionStep(step, nextEnv) })).toContain('observed v7');
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('Capacity feedback after reduction 1');
  expect(await f.db.prepare('select count(*) as n from agent_runs').first('n')).toBe(1);
  expect(await f.db.prepare('select count(*) as n from agent_task_model_reservations').first('n')).toBe(2);
});

it('splits serialized messages only between complete entries and preserves Unicode fragments', () => {
  const messages = [{ content: 'Entity A 🙂' }, { content: 'Entity B' }, { content: 'pending' }];
  const parts = summaryFragments(JSON.stringify(messages))!;
  expect(parts.flatMap(part => JSON.parse(part))).toEqual(messages);
  expect(summaryFragments('A 🙂 B')!.join('')).toBe('A 🙂 B');
});
