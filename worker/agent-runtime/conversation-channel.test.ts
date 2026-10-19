import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { conversationChannel } from './conversation-channel';
import { conversationTool } from './conversation-tools';
import { testModelProfile } from './model-registry.test-fixture';

describe('native conversation channel wire protocol', () => {
  it('serializes native history and multiple calls, preserving channel transforms and decoded stop reason', async () => {
    let request: Record<string, unknown> = {};
    const channel = conversationChannel(testModelProfile({ provider: 'fixture', keyName: 'MODEL_API_KEY',
      baseUrl: 'https://example.invalid/v1', model: 'gpt-5-test', contextWindow: 32000, maxOutputTokens: 1000,
      reasoningSupported: false, compatibility: { maxTokensField: 'max_completion_tokens' } }), async (url, init) => {
        expect(String(url)).toBe('https://example.invalid/v1/chat/completions');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
        request = JSON.parse(String(init?.body));
        const chunks = [
          { id: 'completion-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking', tool_calls: [
            { index: 0, id: 'call-a', type: 'function', function: { name: 'read_fact', arguments: '{"key":"product"}' } },
            { index: 1, id: 'call-b', type: 'function', function: { name: 'read_fact', arguments: '{"key":"audience"}' } },
          ] }, finish_reason: null }] },
          { id: 'completion-1', choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } },
        ];
        return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      });
    const tool = conversationTool({ name: 'read_fact', description: 'Read confirmed fact', inputSchema: z.object({ key: z.string() }) }, async () => ({ content: [], details: null }));
    const stream = await channel.stream(channel.model, {
      systemPrompt: 'Research internally', messages: [{ role: 'user', content: 'Refresh strategy', timestamp: 1 }], tools: [tool],
    }, { maxTokens: 1000 });
    const result = await stream.result();
    expect(request.messages).toEqual([{ role: 'system', content: 'Research internally' }, { role: 'user', content: 'Refresh strategy' }]);
    expect(request.max_completion_tokens).toBe(1000);
    expect(request).not.toHaveProperty('max_tokens');
    expect(request).not.toHaveProperty('reasoning_effort');
    expect(request.tool_choice).not.toBe('required');
    expect(result.stopReason).toBe('length');
    expect(result.content.filter(c => c.type === 'toolCall').map(c => ({ id: c.id, arguments: c.arguments }))).toEqual([
      { id: 'call-a', arguments: { key: 'product' } }, { id: 'call-b', arguments: { key: 'audience' } },
    ]);
    expect(result.usage).toMatchObject({ input: 20, output: 30 });
  });

  it('encodes HTTP failures into the SDK stream without hidden retries', async () => {
    let requests = 0;
    const channel = conversationChannel(testModelProfile({ model: 'fixture-test', contextWindow: 32000,
      maxOutputTokens: 1000, reasoningSupported: false }), async () => {
        requests++;
        return new Response(JSON.stringify({ error: { message: 'Unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
      });
    const result = await (await channel.stream(channel.model, { messages: [{ role: 'user', content: 'Research', timestamp: 1 }] })).result();
    expect(result.stopReason).toBe('error');
    expect(requests).toBe(1);
  });
});
