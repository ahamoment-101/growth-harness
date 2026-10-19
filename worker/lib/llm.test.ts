import { afterEach, describe, expect, it, vi } from 'vitest';
import { testModelProfile } from '../agent-runtime/model-registry.test-fixture';
import { completeJsonWithMeta, ModelHttpError, ModelResponseError } from './llm';

afterEach(() => vi.unstubAllGlobals());

describe('structured JSON generation', () => {
  const profile = testModelProfile({ model: 'fixture-model', baseUrl: 'https://model.invalid/v1',
    reasoningRequired: true, minimumReasoningEffort: 'low' });
  it('sends a pinned protocol request without aggregator routing fields', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '{"answer":"ok"}',
          },
        }],
      }), { status: 200 });
    }));

    const response = await completeJsonWithMeta<{ answer: string }>({
      profile,
      system: 'system',
      user: 'user',
      schemaName: 'research',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
      maxCompletionTokens: 5000,
      reasoningEffort: 'none',
    });

    expect(requestUrl).toBe(`${profile.baseUrl}/chat/completions`);
    expect(requestBody.model).toBe('fixture-model');
    expect(requestBody.tools).toBeUndefined();
    expect(requestBody.max_tokens).toBe(5000);
    expect(requestBody.reasoning).toEqual({ effort: 'low' });
    expect(requestBody.provider).toBeUndefined();
    expect(requestBody.usage).toBeUndefined();
    expect(response).toEqual({
      data: { answer: 'ok' },
      citations: [],
    });
  });

  it('preserves the HTTP status for workflow retry decisions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider rejected request', { status: 403 })));

    await expect(completeJsonWithMeta({
      profile,
      system: 'system',
      user: 'user',
      schemaName: 'research',
      schema: { type: 'object', properties: {} },
    })).rejects.toMatchObject({ name: 'ModelHttpError', status: 403 } satisfies Partial<ModelHttpError>);
  });

  it('accepts a complete JSON response wrapped in a Markdown code fence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n{"answer":"ok"}\n```' } }],
    }), { status: 200 })));

    await expect(completeJsonWithMeta<{ answer: string }>({
      profile, system: 'system', user: 'user',
      schemaName: 'research', schema: { type: 'object', properties: { answer: { type: 'string' } } },
    })).resolves.toEqual({ data: { answer: 'ok' }, citations: [] });
  });

  it('still rejects prose around otherwise valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Here is the result: {"answer":"ok"}' } }],
    }), { status: 200 })));

    await expect(completeJsonWithMeta({
      profile, system: 'system', user: 'user',
      schemaName: 'research', schema: { type: 'object', properties: { answer: { type: 'string' } } },
    })).rejects.toMatchObject({
      name: 'ModelResponseError', modelCallMeta: { code: 'invalid_json' },
    });
  });

  it('reports provider usage without exposing the request body', async () => {
    const onUsage = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'generation-1', model: 'fixture-model',
      usage: { prompt_tokens: 21, completion_tokens: 8 },
      choices: [{ message: { content: '{"answer":"ok"}' } }],
    }), { status: 200 })));
    await completeJsonWithMeta({
      profile,
      system: 'system', user: 'user', schemaName: 'research',
      schema: { type: 'object', properties: { answer: { type: 'string' } } }, onUsage,
    });
    expect(onUsage).toHaveBeenCalledWith({
      provider: 'fixture', model: 'fixture-model', requestId: 'generation-1',
      inputTokens: 21, outputTokens: 8, costUsd: 0,
    });
  });

  it('preserves safe provider metadata when a successful HTTP response has no content', async () => {
    const onUsage = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'generation-empty', model: 'fixture-model',
      usage: { prompt_tokens: 34, completion_tokens: 120 },
      choices: [{ finish_reason: 'length', message: { content: '' } }],
    }), { status: 200 })));

    await expect(completeJsonWithMeta({
      profile,
      system: 'system', user: 'user', schemaName: 'research',
      schema: { type: 'object', properties: {} }, onUsage,
    })).rejects.toMatchObject({
      name: 'ModelResponseError',
      modelCallMeta: {
        code: 'missing_content', requestId: 'generation-empty', provider: 'fixture',
        model: 'fixture-model', finishReason: 'length', inputTokens: 34, outputTokens: 120, costUsd: 0,
      },
    } satisfies Partial<ModelResponseError>);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'generation-empty', outputTokens: 120 }));
  });
});
