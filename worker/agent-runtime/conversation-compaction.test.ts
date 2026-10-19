import { expect, it } from 'vitest';
import { compactConversation, compactIsolatedContext, measureRequest } from './conversation-compaction';
import { appendConversationMessage, conversationResumePoint, initializeConversation, readConversation } from './conversation-store';
import type { AssistantMessage, Context, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { replayConversationResponse } from './conversation-replay';
import { taskTestDb } from './task-test-db';
import { attachTask } from './task-store';
import { agentDefinition } from './definitions';
import { compactionMessage, semanticMessage } from './message-view';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';

it('fits the exact restored summary envelope before committing a compaction', async () => {
  const f = taskTestDb(); const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const instructions = 'i'.repeat(17000);
  await initializeConversation(f.db, task, instructions, {});
  await appendConversationMessage(f.db, task, 'source', { role: 'user', timestamp: 0, content: 'x'.repeat(12000) });
  const snapshot = (await readConversation(f.db, task))!;
  const model = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.invalid',
    reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<'openai-completions'>;
  let size = 0;
  const bare = (text: string): Context => ({ systemPrompt: instructions, messages: [{ role: 'user', timestamp: 0, content: text }] });
  let upper = 30000;
  while (size < upper) {
    const middle = Math.ceil((size + upper) / 2);
    if (measureRequest(bare('s'.repeat(middle)), 1000, 10000).fits) size = middle;
    else upper = middle - 1;
  }
  const nearLimit = 's'.repeat(size);
  expect(measureRequest({ ...bare(''), messages: [compactionMessage(1, nearLimit)] }, 1000, 10000).fits).toBe(false);
  let calls = 0;
  const stream: StreamFn = (selected, context, options) => {
    const text = ++calls === 1 ? nearLimit : 'Goal and source retained; next action remains pending.';
    const response = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, timestamp: 0,
      stopReason: 'stop', content: [{ type: 'text', text }], usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
    return replayConversationResponse(response, stream)(selected, context, options);
  };
  const result = await compactConversation({ env: { DB: f.db } as RuntimeAgentEnv,
    step: { do: async (_key: string, _config: unknown, fn: () => Promise<unknown>) => fn() } as RuntimeWorkflowStep,
    task, snapshot, model, stream, outputTokens: 1000, context: { systemPrompt: instructions, messages: snapshot.messages.map(row => row.message) } });
  expect(calls).toBe(2);
  expect(measureRequest({ systemPrompt: result.instructions, messages: conversationResumePoint(result).messages }, 1000, 10000).fits).toBe(true);
});

it('summarizes a batch in one request when the history fits without the business tool schemas', async () => {
  const f = taskTestDb(); const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  await initializeConversation(f.db, task, 'Task', {});
  for (let index = 0; index < 30; index++) await appendConversationMessage(f.db, task, `input:${index}`,
    { role: 'user', timestamp: index, content: `Evidence ${index}: ${'x'.repeat(500)}` });
  const snapshot = (await readConversation(f.db, task))!;
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture',
    baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let requests = 0;
  const stream: StreamFn = (selected, context, options) => {
    requests++;
    expect(String(context.messages[0].content)).toContain('Evidence 0:');
    expect(String(context.messages[0].content)).toContain('Evidence 28:');
    const response: AssistantMessage = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
      timestamp: 0, stopReason: 'stop', content: [{ type: 'text', text: 'Evidence 0–28 retained in archive. Verify the latest observation next.' }],
      usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return replayConversationResponse(response, stream)(selected, context, options);
  };
  const result = await compactConversation({ env: { DB: f.db } as RuntimeAgentEnv,
    step: { do: async (_key: string, _config: unknown, fn: () => Promise<unknown>) => fn() } as RuntimeWorkflowStep,
    task, snapshot, model, stream, outputTokens: 1000,
    context: { messages: snapshot.messages.map(row => row.message), tools: [{ name: 'business', description: 'd'.repeat(15000), parameters: {} as never }] } });
  expect(requests).toBe(1);
  expect(result.compaction?.throughSequence).toBe(29);
  expect(result.messages.at(-1)?.key).toBe('input:29');
});

it('measures full model input while excluding the duplicate host-only tool receipt', () => {
  const context: Context = { systemPrompt: 'Identity', messages: [{ role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'Full source text' }], isError: false, timestamp: 0 }] };
  const baseline = measureRequest(context, 8000, 128000);
  const withReceipt = { ...context, messages: [{ ...context.messages[0], details: { source: 'x'.repeat(500000) } }] };
  expect(measureRequest(withReceipt, 8000, 128000)).toEqual(baseline);
  const moreInput = { ...context, systemPrompt: 'Identity' + 'Policy'.repeat(1000) };
  expect(measureRequest(moreInput, 8000, 128000).bytes - baseline.bytes).toBe(6000);
  expect(baseline).toMatchObject({ outputTokens: 8000, measurement: 'text_estimate' });
});

it('processes every oversized isolated fragment and reuses durable summaries after recovery', async () => {
  const f = taskTestDb(); const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const material: Context = { systemPrompt: 'Review the supplied evidence', messages: [{ role: 'user', timestamp: 0, content: 'Full original observation🙂\n'.repeat(15000) }] };
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const parts: string[] = [];
  const stream: StreamFn = (model, context, options) => {
    parts.push(String(context.messages[0].content));
    const response: AssistantMessage = { role: 'assistant', api: model.api, model: model.id, provider: model.provider, content: [{ type: 'text', text: 'The original observation is retained as evidence; review the remaining work.' }], timestamp: 0, stopReason: 'stop', usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return replayConversationResponse(response, stream)(model, context, options);
  };
  const input = { env: { DB: f.db } as RuntimeAgentEnv, step: { do: async (_key: string, _config: unknown, fn: () => Promise<unknown>) => fn() } as RuntimeWorkflowStep,
    runId: task.active_run_id, requestKey: 'review-operation', context: material, model, stream, outputTokens: 4000 };
  const compacted = await compactIsolatedContext(input);
  expect(JSON.parse(parts.join('')).flat()).toEqual(material.messages.map(semanticMessage));
  const count = parts.length; expect(count).toBeGreaterThan(1);
  expect(await compactIsolatedContext(input)).toEqual(compacted);
  expect(parts).toHaveLength(count);
});
