import { expect, it } from 'vitest';
import { encodeTaskStep, decodeTaskStep } from './task-step-result';
import { ToolContractError, ToolExecutionError, classifyToolFailure } from './tool-failure';
import { TaskStateError, TaskPendingError } from './task-store';

it.each(['edit_article', 'update_customer'])('preserves %s rejection after durable serialization and replay', async tool => {
  const details = { kind: 'invalid_request' as const, effects: 'none' as const, issues: [{ path: [tool, 'revision'], message: 'Required' }], guidance: 'Read current state' };
  const serialized = JSON.parse(JSON.stringify(await encodeTaskStep(async () => { throw new ToolContractError('Rejected', details); })));
  for (let replay = 0; replay < 2; replay++) {
    try { decodeTaskStep(serialized); throw new Error('Expected rejection'); }
    catch (error) { expect(classifyToolFailure(error)).toMatchObject({ ...details, retryable: false }); }
  }
});
it.each([TaskStateError, TaskPendingError])('preserves execution control across serialization', async ErrorType => {
  const serialized = await encodeTaskStep(async () => { throw new ErrorType('control'); });
  expect(() => decodeTaskStep(serialized)).toThrow(ErrorType);
});
it('does not swallow unclassified failures or guess their side effects', async () => {
  await expect(encodeTaskStep(async () => { throw new Error('connection lost after write'); })).rejects.toThrow('connection lost');
  expect(decodeTaskStep(await encodeTaskStep(async () => ({ ok: false, business: 'valid result' })))).toEqual({ ok: false, business: 'valid result' });
});

it.each(['quota exceeded: 402', '401 Unauthorized', 'not configured', 'invalid input', 'unrecognized RPC failure'])('returns %s as a durable observation without automatic retry', async message => {
  const { encodeToolStep } = await import('./task-step-result');
  const serialized = await encodeToolStep(async () => { throw new Error(message); }, { retryable: true, readOnly: true });
  try { decodeTaskStep(serialized); throw new Error('Expected rejection'); }
  catch (error) {
    expect(classifyToolFailure(error)).toMatchObject({ retryable: false, effects: 'none' });
  }
});

it('lets only an allowed transient failure escape into Workflow retry', async () => {
  const { encodeToolStep } = await import('./task-step-result');
  const action = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
  await expect(encodeToolStep(action, { retryable: true, readOnly: true })).rejects.toThrow('fetch failed');
  const encoded = await encodeToolStep(action, { retryable: false, readOnly: true });
  expect(() => decodeTaskStep(encoded)).toThrow('fetch failed');
  const unknownEffect = await encodeToolStep(action, { retryable: true, readOnly: false });
  try { decodeTaskStep(unknownEffect); } catch (error) { expect(classifyToolFailure(error).effects).toBe('unknown'); }
});

it('preserves structured retry failure after Workflow flattens the error', async () => {
  const { encodeToolStep, restoreToolStepFailure } = await import('./task-step-result');
  const assessment = { kind: 'transient' as const, retryable: true, effects: 'none', issues: [{ path: ['record'], message: 'Service unavailable' }], guidance: 'No write occurred.' };
  try {
    await encodeToolStep(async () => { throw new ToolExecutionError('Provider unavailable', assessment); }, { retryable: true, readOnly: false });
    throw new Error('Expected a Workflow retry');
  } catch (error) {
    expect(classifyToolFailure(restoreToolStepFailure(new Error(String(error))))).toEqual(assessment);
  }
});

it('carries a model account refusal inside a tool to execution recovery instead of tool feedback', async () => {
  const { encodeToolStep } = await import('./task-step-result');
  const { ExecutionFailureError } = await import('./execution-failure');
  const failure = { origin: 'upstream', scope: 'account', recovery_action: 'new_execution', message: '403: billing required', status: 403, request_id: '', stage: 'isolated_review' } as const;
  const serialized = JSON.parse(JSON.stringify(await encodeToolStep(async () => { throw new ExecutionFailureError(failure); }, { retryable: true, readOnly: true })));
  expect(() => decodeTaskStep(serialized)).toThrow(ExecutionFailureError);
  try { decodeTaskStep(serialized); } catch (error) { expect((error as InstanceType<typeof ExecutionFailureError>).failure).toEqual(failure); }
});
