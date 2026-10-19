import { describe, expect, it } from 'vitest';
import { channelRequestBody } from './model-channel';

describe('protocol parameter compatibility', () => {
  it('uses the configured token field without inferring the model family', () => {
    const body = { model: 'arbitrary-name', max_tokens: 123, messages: [] };
    expect(channelRequestBody({ compatibility: { maxTokensField: 'max_completion_tokens' } }, body))
      .toEqual({ model: 'arbitrary-name', max_completion_tokens: 123, messages: [] });
    expect(body.max_tokens).toBe(123);
  });

  it('preserves provider-neutral schemas and request parameters', () => {
    const body = { tools: [{ type: 'function', function: { name: 'save', parameters: { type: 'object', properties: { version: { const: 1 } } } } }], reasoning_effort: 'low' };
    expect(channelRequestBody({}, body)).toBe(body);
  });
});
