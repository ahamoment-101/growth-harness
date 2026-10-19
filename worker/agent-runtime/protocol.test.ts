import { describe, expect, it } from 'vitest';
import { canTransitionAgentRun, redactRuntimeValue, runtimeJson } from './protocol';

describe('agent runtime protocol', () => {
  it('allows only forward lifecycle transitions', () => {
    expect(canTransitionAgentRun('queued', 'running')).toBe(true);
    expect(canTransitionAgentRun('running', 'waiting_for_input')).toBe(true);
    expect(canTransitionAgentRun('waiting_for_input', 'running')).toBe(true);
    expect(canTransitionAgentRun('succeeded', 'running')).toBe(false);
    expect(canTransitionAgentRun('cancelled', 'failed')).toBe(false);
  });

  it('redacts credentials recursively and bounds event payloads', () => {
    expect(redactRuntimeValue({ authorization: 'Bearer abc', nested: { refresh_token: 'secret', ok: 'Bearer raw' } })).toEqual({
      authorization: '[redacted]',
      nested: { refresh_token: '[redacted]', ok: 'Bearer [redacted]' },
    });
    expect(runtimeJson({ text: 'x'.repeat(40_000) }).length).toBeLessThanOrEqual(32_000);
    expect(redactRuntimeValue('best-app-for-research')).toBe('best-app-for-research');
    expect(redactRuntimeValue('sk-or-v1-abcdefghijklmnop')).toBe('[redacted]');
  });
});
