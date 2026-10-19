import { describe, expect, it } from 'vitest';
import { classifyRuntimeModelFailure, RuntimeValidationError, runtimeValidation } from './model-errors';

describe('Runtime model failure classification', () => {
  it('keeps provider and empty-response failures in Runtime recovery', () => {
    expect(classifyRuntimeModelFailure(Object.assign(new Error('Model response missing content'), {
      name: 'ModelResponseError',
    })).kind).toBe('transport');
    expect(classifyRuntimeModelFailure(Object.assign(new Error('provider prohibited request'), {
      name: 'AI_APICallError', statusCode: 403,
    })).kind).toBe('transport');
    expect(classifyRuntimeModelFailure(Object.assign(new Error('No output generated'), {
      name: 'AI_NoOutputGeneratedError',
    })).kind).toBe('transport');
  });

  it('returns malformed Agent actions as repairable output feedback', () => {
    expect(classifyRuntimeModelFailure(new Error('Topic decision must return exactly one tool call; received 0')).kind).toBe('invalid_output');
    expect(classifyRuntimeModelFailure(new Error('Topic decision selected an unavailable action: search_web')).kind).toBe('invalid_output');
  });

  it('distinguishes a truncated completion from an ordinary malformed action', () => {
    const error = Object.assign(new Error('Content production decision must return exactly one tool call; received 0'), {
      modelCallMeta: { finishReason: 'length' },
    });
    expect(classifyRuntimeModelFailure(error)).toEqual({
      kind: 'output_truncated', message: error.message, finishReason: 'length',
    });
  });

  it('never lets model-supplied text in a validation message look like a transport failure', () => {
    // These strings are quoted straight out of strategy keywords and search results.
    // Before type-first classification each one matched the transport heuristic,
    // and the decision loop rethrows transport failures instead of repairing them.
    const messages = [
      'Topic decision references an unknown strategy keyword: sk_network_monitoring',
      'Topic decision changed the strategic keyword text: how to fix a slow network connection',
      'Topic decision cites Web evidence that was not returned by search_web: socket.io guide',
      'Topic decision duplicates an existing primary keyword: api rate limit best practices',
    ];
    for (const message of messages) {
      expect(classifyRuntimeModelFailure(new RuntimeValidationError(message)).kind).toBe('invalid_output');
    }
  });

  it('keeps a genuine provider failure transport even when raised near validation', () => {
    expect(classifyRuntimeModelFailure(Object.assign(new Error('fetch failed'), {
      name: 'AI_APICallError', statusCode: 502,
    })).kind).toBe('transport');
  });

  it('republishes schema failures as validation so their quoted text is inert', () => {
    const zodLike = Object.assign(new Error('Invalid enum value. Received "network timeout"'), { name: 'ZodError' });
    const failure = classifyRuntimeModelFailure((() => {
      try {
        runtimeValidation(() => { throw zodLike; });
        return new Error('unreachable');
      } catch (error) { return error; }
    })());
    expect(failure.kind).toBe('invalid_output');
  });

  it('lets a programming error through runtimeValidation unchanged', () => {
    expect(() => runtimeValidation(() => { throw new TypeError('x is not a function'); })).toThrow(TypeError);
  });
});
