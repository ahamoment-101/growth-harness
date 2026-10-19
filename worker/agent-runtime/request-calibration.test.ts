import { expect, it } from 'vitest';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { calibratedRequestCapacity, measuredAssistant } from './request-calibration';
import { requestCapacity } from './request-capacity';

const model = { provider: 'test', id: 'model', baseUrl: 'https://example.invalid/v1', contextWindow: 10000, maxTokens: 1000 };
const response: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider: model.provider, model: model.id,
  timestamp: 1, stopReason: 'stop', content: [{ type: 'text', text: 'Observed entity-1 version 7.' }],
  usage: { input: 300, cacheRead: 100, cacheWrite: 50, output: 20, totalTokens: 470,
    cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } } };
const original: Context = { systemPrompt: 'Task identity', messages: [{ role: 'user', timestamp: 0, content: 'Evidence '.repeat(1000) }] };

it('uses reported input including cached tokens only for an unchanged request prefix', async () => {
  const saved = await measuredAssistant(response, original, model);
  const context = { ...original, messages: [...original.messages, saved, { role: 'user' as const, timestamp: 2, content: 'Next observation' }] };
  const capacity = await calibratedRequestCapacity(context, model);
  const delta = requestCapacity(context, 10000, 1000).estimatedInputTokens - requestCapacity(original, 10000, 1000).estimatedInputTokens;
  expect(capacity.measurement).toBe('provider_usage_plus_delta');
  expect(capacity.estimatedInputTokens).toBe(450 + delta);
  expect(await calibratedRequestCapacity(JSON.parse(JSON.stringify(context)), model)).toEqual(capacity);
});

it('invalidates measurements after compaction, identity/tool changes or a different endpoint', async () => {
  const saved = await measuredAssistant(response, original, model);
  const context = { ...original, messages: [...original.messages, saved] };
  for (const changed of [
    { ...context, systemPrompt: 'Different identity' },
    { ...context, messages: [{ role: 'user' as const, timestamp: 0, content: 'A compressed summary' }, saved] },
    { ...context, tools: [{ name: 'new_tool', description: 'New schema', parameters: {} as never }] },
  ]) expect((await calibratedRequestCapacity(changed, model)).measurement).toBe('text_estimate');
  expect((await calibratedRequestCapacity(context, { ...model, baseUrl: 'https://another.invalid' })).measurement).toBe('text_estimate');
  const legacy = JSON.parse(JSON.stringify(context));
  delete legacy.messages.at(-1).runtimeCapacity.measurementVersion;
  expect((await calibratedRequestCapacity(legacy, model)).measurement).toBe('text_estimate');
});
