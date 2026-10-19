import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Context } from '@earendil-works/pi-ai';
import { conversationChannel } from './conversation-channel';
import { conversationTool } from './conversation-tools';
import { testModelProfile } from './model-registry.test-fixture';

const args = { reference: 'observed-entity-7', version: 3 };
const tool = conversationTool({ name: 'patch_fact', description: 'Patch an observed fact',
  inputSchema: z.object({ reference: z.string(), version: z.number() }) }, async () => ({ content: [], details: null }));
const context: Context = { systemPrompt: 'Choose an action', messages: [{ role: 'user', content: 'Patch the observed fact', timestamp: 1 }], tools: [tool] };

describe('native provider protocol streams', () => {
  it.each(['openai-chat', 'openai-responses', 'anthropic-messages'] as const)('returns %s HTTP failure without an SDK retry', async protocol => {
    let calls = 0;
    const channel = conversationChannel(testModelProfile({ protocol }), async () => {
      calls++;
      return new Response(JSON.stringify({ error: { type: 'api_error', message: 'Unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    });
    const result = await (await channel.stream(channel.model, context)).result();
    expect(result.stopReason).toBe('error');
    expect(calls).toBe(1);
  });

  it('serializes Anthropic Messages and preserves tool references through a receipt round trip', async () => {
    const requests: any[] = [];
    const channel = conversationChannel(testModelProfile({ protocol: 'anthropic-messages', reasoningSupported: false }), async (url, init) => {
      expect(String(url)).toBe('https://model.invalid/v1/messages');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('test-key');
      expect(headers.get('anthropic-version')).toBeTruthy();
      requests.push(JSON.parse(String(init?.body)));
      const events = [
        { type: 'message_start', message: { id: 'native-1', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'patch_fact', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    });
    const first = await (await channel.stream(channel.model, context)).result();
    expect(first.errorMessage).toBeUndefined();
    expect(first.stopReason).toBe('toolUse');
    expect(first.content).toContainEqual(expect.objectContaining({ type: 'toolCall', id: 'tool-1', name: 'patch_fact', arguments: args }));
    expect(first.usage).toMatchObject({ input: 12, output: 8 });
    await (await channel.stream(channel.model, { ...context, messages: [...context.messages, first,
      { role: 'toolResult', toolCallId: 'tool-1', toolName: 'patch_fact', content: [{ type: 'text', text: 'saved-receipt-9' }], isError: false, timestamp: 2 },
    ] })).result();
    expect(requests[0].tools[0]).toMatchObject({ name: 'patch_fact', input_schema: { properties: { version: { type: 'number' } } } });
    expect(JSON.stringify(requests[1].messages)).toContain('saved-receipt-9');
    expect(JSON.stringify(requests[1].messages)).toContain('tool_use_id');
    expect(JSON.stringify(requests[1].messages)).toContain('tool-1');
  });

  it('serializes Responses function calls and returns correlated outputs in the next request', async () => {
    const requests: any[] = [];
    const item = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'patch_fact', arguments: JSON.stringify(args), status: 'completed' };
    const channel = conversationChannel(testModelProfile({ protocol: 'openai-responses', reasoningSupported: false }), async (url, init) => {
      expect(String(url)).toBe('https://model.invalid/v1/responses');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
      requests.push(JSON.parse(String(init?.body)));
      const events = [
        { type: 'response.created', response: { id: 'response-1', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc-1', output_index: 0, delta: JSON.stringify(args) },
        { type: 'response.function_call_arguments.done', item_id: 'fc-1', output_index: 0, arguments: JSON.stringify(args) },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [item], usage: { input_tokens: 15, output_tokens: 7, total_tokens: 22, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    });
    const first = await (await channel.stream(channel.model, context)).result();
    expect(first.errorMessage).toBeUndefined();
    expect(first.stopReason).toBe('toolUse');
    expect(first.content).toContainEqual(expect.objectContaining({ type: 'toolCall', name: 'patch_fact', arguments: args }));
    const id = first.content.find(block => block.type === 'toolCall')!.id;
    await (await channel.stream(channel.model, { ...context, messages: [...context.messages, first,
      { role: 'toolResult', toolCallId: id, toolName: 'patch_fact', content: [{ type: 'text', text: 'saved-receipt-9' }], isError: false, timestamp: 2 },
    ] })).result();
    expect(requests[0].tools[0]).toMatchObject({ type: 'function', name: 'patch_fact' });
    expect(requests[1].input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call-1', output: 'saved-receipt-9' }));
    expect(first.usage).toMatchObject({ input: 15, output: 7 });
  });
});
