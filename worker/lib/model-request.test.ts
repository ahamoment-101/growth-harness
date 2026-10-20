import { afterEach, describe, expect, it, vi } from 'vitest';
import { testModelProfile } from '../agent-runtime/model-registry.test-fixture';
import type { ModelProtocol } from '../../shared/config/models';
import { completeJsonWithMeta } from './llm';
import { requestLocalization } from './localize';
import { ModelHttpError, requestModelText } from './model-request';
import { conversationChannel } from '../agent-runtime/conversation-channel';
import type { ResolvedModelProfile } from '../../shared/config/models';

afterEach(() => vi.unstubAllGlobals());

describe('reasoning capability consistency', () => {
  it.each<{
    name: string;
    profile: Partial<ResolvedModelProfile>;
    requested?: 'none' | 'minimal' | 'medium' | 'high';
    expected: Record<string, unknown>;
  }>([
    { name: 'the verified minimum', profile: { minimumReasoningEffort: 'low', supportedParameters: ['reasoning_effort'], compatibility: { supportsReasoningEffort: true } }, requested: 'minimal', expected: { reasoning_effort: 'low' } },
    { name: 'required reasoning when omitted by the caller', profile: { reasoningRequired: true, compatibility: { supportsReasoningEffort: true } }, expected: { reasoning_effort: 'minimal' } },
    { name: 'the verified minimum when none is requested', profile: { minimumReasoningEffort: 'low', compatibility: { supportsReasoningEffort: true } }, requested: 'none', expected: { reasoning_effort: 'low' } },
    { name: 'required reasoning when none is requested', profile: { reasoningRequired: true, compatibility: { supportsReasoningEffort: true } }, requested: 'none', expected: { reasoning_effort: 'minimal' } },
    { name: 'unsupported reasoning', profile: { reasoningSupported: false, compatibility: { supportsReasoningEffort: true } }, requested: 'high', expected: {} },
    { name: 'an explicitly unsupported control despite catalog metadata', profile: { supportedParameters: ['reasoning'], compatibility: { supportsReasoningEffort: false } }, requested: 'minimal', expected: {} },
    { name: 'the OpenRouter format despite catalog metadata', profile: { supportedParameters: ['reasoning_effort'], compatibility: { thinkingFormat: 'openrouter', supportsReasoningEffort: false } }, requested: 'medium', expected: { reasoning: { effort: 'medium' } } },
    { name: 'the OpenAI format despite catalog metadata', profile: { supportedParameters: ['reasoning'], compatibility: { thinkingFormat: 'openai', supportsReasoningEffort: true } }, requested: 'high', expected: { reasoning_effort: 'high' } },
  ])('uses $name for both conversation and text requests', async ({ profile: overrides, requested, expected }) => {
    const profile = testModelProfile(overrides);
    const bodies: Array<Record<string, unknown>> = [];
    const fetchRequest: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.stream) return new Response(`data: ${JSON.stringify({ id: 'probe', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }));
    };
    const channel = conversationChannel(profile, fetchRequest);
    const streamed = await (await channel.stream(channel.model, {
      messages: [{ role: 'user', content: 'Synthetic question', timestamp: 0 }],
    }, { reasoning: requested === 'none' ? undefined : requested })).result();
    expect(streamed.stopReason).toBe('stop');
    vi.stubGlobal('fetch', fetchRequest);
    await requestModelText(profile, { messages: [{ role: 'user', content: 'Synthetic question' }], reasoningEffort: requested });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(Object.fromEntries(Object.entries(body).filter(([key]) => key === 'reasoning' || key === 'reasoning_effort'))).toEqual(expected);
    }
  });
});

describe.each<{ name: string; profile: Partial<ResolvedModelProfile>; expected: Record<string, unknown> }>([
  { name: 'OpenAI Chat', profile: { compatibility: { thinkingFormat: 'openai', supportsReasoningEffort: true } }, expected: {} },
  { name: 'OpenRouter', profile: { compatibility: { thinkingFormat: 'openrouter', supportsReasoningEffort: true } }, expected: { reasoning: { effort: 'none' } } },
  { name: 'OpenAI Responses', profile: { protocol: 'openai-responses' }, expected: { reasoning: { effort: 'none' } } },
  { name: 'Anthropic adaptive', profile: { protocol: 'anthropic-messages', compatibility: { forceAdaptiveThinking: true } }, expected: { thinking: { type: 'disabled' } } },
  { name: 'Anthropic budget', profile: { protocol: 'anthropic-messages', compatibility: { thinkingBudgetTokens: 1024 } }, expected: { thinking: { type: 'disabled' } } },
])('$name optional reasoning', ({ profile: overrides, expected }) => {
  it.each([undefined, 'none'] as const)('preserves the native disabled request when effort is %s', async requested => {
    const profile = testModelProfile({ ...overrides, reasoningRequired: false });
    const bodies: Array<Record<string, unknown>> = [];
    const channel = conversationChannel(profile, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      // Capture the serialized request without needing a protocol-specific response stream.
      return new Response(JSON.stringify({ error: { message: 'Synthetic request captured' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    expect((await (await channel.stream(channel.model, {
      messages: [{ role: 'user', content: 'Synthetic question', timestamp: 0 }],
    })).result()).stopReason).toBe('error');
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('{}');
    });
    await requestModelText(profile, { messages: [{ role: 'user', content: 'Synthetic question' }], reasoningEffort: requested });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(Object.fromEntries(Object.entries(body).filter(([key]) => ['reasoning', 'reasoning_effort', 'thinking', 'output_config'].includes(key)))).toEqual(expected);
    }
  });
});

describe.each<ModelProtocol>(['openai-chat', 'openai-responses', 'anthropic-messages'])('%s text and structured output', protocol => {
  const profile = testModelProfile({ protocol, reasoningSupported: false });
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  function result(content: string, truncated = false) {
    if (protocol === 'anthropic-messages') return { id: 'native-1', model: profile.model,
      content: [{ type: 'text', text: content }], stop_reason: truncated ? 'max_tokens' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    if (protocol === 'openai-responses') return { id: 'response-1', model: profile.model, status: truncated ? 'incomplete' : 'completed',
      incomplete_details: truncated ? { reason: 'max_output_tokens' } : null,
      output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 10, output_tokens: 5 } };
    return { id: 'chat-1', choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  }

  it('serializes the endpoint, credentials and schema, then reads native usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(String(url)).toBe(profile.baseUrl + (protocol === 'anthropic-messages' ? '/messages' : protocol === 'openai-responses' ? '/responses' : '/chat/completions'));
      const headers = new Headers(init.headers);
      expect(headers.get(protocol === 'anthropic-messages' ? 'x-api-key' : 'authorization')).toBe(protocol === 'anthropic-messages' ? 'test-key' : 'Bearer test-key');
      const body = JSON.parse(init.body);
      if (protocol === 'anthropic-messages') {
        expect(headers.get('anthropic-version')).toBe('2023-06-01');
        expect(body).toMatchObject({ system: 'System', max_tokens: 200, output_config: { format: { type: 'json_schema', schema } } });
      } else if (protocol === 'openai-responses') {
        expect(body).toMatchObject({ instructions: 'System', max_output_tokens: 200, store: false, text: { format: { name: 'answer', schema } } });
      } else expect(body).toMatchObject({ messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Question' }], response_format: { json_schema: { schema } } });
      return new Response(JSON.stringify(result('{"answer":"ok"}')));
    }));
    const onUsage = vi.fn();
    expect((await completeJsonWithMeta({ profile, system: 'System', user: 'Question', schemaName: 'answer', schema, maxCompletionTokens: 200, onUsage })).data).toEqual({ answer: 'ok' });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 10, outputTokens: 5, provider: 'fixture' }));
  });

  it('localizes through the selected protocol and rejects incomplete output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(result('Bonjour')))));
    expect(await requestLocalization(profile, [{ role: 'user', content: 'Translate the title' }])).toBe('Bonjour');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(result('Bon', true)))));
    await expect(requestLocalization(profile, [{ role: 'user', content: 'Translate the title' }])).rejects.toThrow('cut off');
  });

  it('preserves HTTP errors without exposing an echoed credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rejected test-key', { status: 403 })));
    await expect(requestModelText(profile, { messages: [] })).rejects.toBeInstanceOf(ModelHttpError);
    await expect(requestModelText(profile, { messages: [] })).rejects.not.toThrow('test-key');
  });
});
