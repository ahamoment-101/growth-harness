import { afterEach, describe, expect, it, vi } from 'vitest';
import { testModelProfile } from '../agent-runtime/model-registry.test-fixture';
import type { ModelProtocol } from '../../shared/config/models';
import { completeJsonWithMeta } from './llm';
import { requestLocalization } from './localize';
import { ModelHttpError, requestModelText } from './model-request';

afterEach(() => vi.unstubAllGlobals());

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
