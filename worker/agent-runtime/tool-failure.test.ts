import { describe, expect, it } from 'vitest';
import {
  ToolContractError,
  classifyToolFailure,
  recordToolFailure,
  toolFailureObservation,
} from './tool-failure';
import { classifyRuntimeModelFailure } from './model-errors';

describe('tool failure assessment', () => {
  it.each(['quota exceeded: 432', 'fetch failed', 'invalid input', '401 Unauthorized'])('does not infer a remedy from arbitrary text: %s', message => {
    expect(classifyToolFailure(new Error(message))).toMatchObject({ kind: 'unknown', retryable: false });
  });

  it('uses transport facts without deciding business strategy', () => {
    expect(classifyToolFailure(Object.assign(new Error('opaque'), { status: 429 }))).toMatchObject({ kind: 'rate_limited', retryable: true });
    expect(classifyToolFailure(Object.assign(new Error('opaque'), { cause: { code: 'ECONNRESET' } }))).toMatchObject({ kind: 'transient', retryable: true });
    expect(classifyToolFailure(Object.assign(new Error('opaque'), { status: 400 })).kind).toBe('unknown');
  });

  it('preserves observations and repetition without retiring a source', () => {
    const failures: Record<string, number> = {};
    const error = new Error('provider capacity unavailable');
    recordToolFailure(failures, 'deep_research', error);
    expect(toolFailureObservation({ error, toolName: 'deep_research', priorFailures: failures })).toMatchObject({ error: error.message, repeat_failures: 2, failure_kind: 'unknown' });
  });

});

describe('model failure classification', () => {
  it('does not tell the model to repair output the platform never let it produce', () => {
    // The production incident: a Worker capacity refusal classified as
    // invalid_output, so eighteen consecutive turns fed the model "repair your
    // previous answer" for an answer it had never been allowed to generate.
    const failure = classifyRuntimeModelFailure(
      new Error('Too many subrequests by single Worker invocation. To configure this limit, refer to the docs'),
    );
    expect(failure.kind).toBe('platform_capacity');
    expect(failure.kind).not.toBe('invalid_output');
  });

  it('keeps provider outages and malformed answers distinguishable', () => {
    expect(classifyRuntimeModelFailure(new Error('fetch failed')).kind).toBe('transport');
    expect(classifyRuntimeModelFailure(new Error('exceeded the CPU limit')).kind).toBe('platform_capacity');
  });


});

it('keeps invalid arguments repairable without retiring a tool', () => {
  expect(classifyToolFailure(new Error('invalid input')).retryable).toBe(false);
});

it('transports domain issues and known effects for different semantic tools', () => {
  for (const toolName of ['update_customer', 'revise_article']) {
    const error = new ToolContractError('State moved', { kind: 'state_conflict', issues: [{ path: ['revision'], message: 'Read current revision' }], effects: 'preserved', guidance: 'Read current state.' });
    expect(toolFailureObservation({ error, toolName, priorFailures: {} })).toMatchObject({ failure_kind: 'state_conflict', retryable: false, effects: 'preserved', issues: error.details.issues, guidance: 'Read current state.' });
  }
});
