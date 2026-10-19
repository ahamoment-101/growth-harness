import { describe, expect, it } from 'vitest';
import { publicStrategyError } from './error';
import { ModelHttpError } from '../llm';
import { SearchHttpError } from './search';

describe('publicStrategyError', () => {
  it('turns provider 403 payloads into an actionable message without leaking identifiers', () => {
    const message = publicStrategyError(new ModelHttpError(
      403, '{"user_id":"user_private","api_key":"sk-or-secret"}',
    ));
    expect(message).toContain('restricted by terms of service or permissions');
    expect(message).not.toContain('user_private');
    expect(message).not.toContain('sk-or-secret');
  });

  it('redacts provider credentials from unexpected errors', () => {
    const message = publicStrategyError(new SearchHttpError(400));
    expect(message).not.toContain('subscription-secret-key');
  });

  it('does not expose raw provider payloads for other 4xx or schema failures', () => {
    expect(publicStrategyError(new Error('Model 400: {"user_id":"private"}'))).not.toContain('private');
    expect(publicStrategyError(new Error('Schema validation failed: {"prompt":"private context"}'))).toBe(
      'The structure returned by the model does not conform to the strategy research protocol; the results were not activated this time. Please retry.',
    );
  });
});
