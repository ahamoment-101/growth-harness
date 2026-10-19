import { expect, it } from 'vitest';
import { z } from 'zod';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { parseIsolatedReview } from './isolated-review';
import { classifyToolFailure } from './tool-failure';
import { encodeTaskStep, decodeTaskStep } from './task-step-result';

it.each([
  { stopReason: 'length', text: '{"finding":"candidate-7' },
  { stopReason: 'stop', text: 'candidate-7 needs evidence' },
  { stopReason: 'stop', text: '{"finding":17}' },
] as const)('retains unvalidated review evidence through durable error transport: %j', async value => {
  const response = { stopReason: value.stopReason, content: [{ type: 'text', text: value.text }] } as AssistantMessage;
  const encoded = await encodeTaskStep(async () => parseIsolatedReview(response, z.object({ finding: z.string() }), 'review:op-1'));
  try { decodeTaskStep(encoded); throw new Error('Expected review rejection'); }
  catch (error) { expect(classifyToolFailure(error)).toMatchObject({ kind: 'invalid_output', effects: 'none', retryable: false,
    observation: { requestId: 'review:op-1', stopReason: value.stopReason, text: value.text } }); }
});

it('returns the validated review without inventing findings', () => {
  const response = { stopReason: 'stop', content: [{ type: 'text', text: '{"finding":"candidate-7 lacks evidence"}' }] } as AssistantMessage;
  expect(parseIsolatedReview(response, z.object({ finding: z.string() }), 'review:op-2')).toEqual({ finding: 'candidate-7 lacks evidence' });
});
