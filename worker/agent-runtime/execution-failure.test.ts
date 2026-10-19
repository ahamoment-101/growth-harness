import { describe, expect, it } from 'vitest';
import { executionFailure, encodeExecution, encodeExecutionBoundary, decodeExecution, ExecutionFailureError } from './execution-failure';
import { encodeTaskStep, decodeTaskStep } from './task-step-result';
const message = 'Too many subrequests by single Worker invocation. To configure this limit, refer to the docs';
describe('execution failure boundary', () => {
  it.each([message, message.replace('subrequests', 'API requests'), 'Worker exceeded CPU time limit.', 'Worker exceeded CPU limit'])('retains native capacity evidence across a durable JSON round trip: %s', async (message) => {
    const result = JSON.parse(JSON.stringify(await encodeExecution(async () => { throw new Error(message); }, 'model_fetch')));
    expect(result.failure).toMatchObject({origin: 'local_platform', scope: 'execution', recovery_action: 'new_execution', stage: 'model_fetch'});
    expect(() => decodeExecution(result)).toThrow(message);
  });
  it('never treats upstream CPU text, memory exhaustion or an overloaded host as replaceable local CPU exhaustion', () => {
    expect(executionFailure(Object.assign(new Error(message), {name: 'AI_APICallError', statusCode: 503}))).toMatchObject({origin: 'upstream', recovery_action: 'retry_request'});
    expect(executionFailure(Object.assign(new Error('Worker exceeded CPU time limit.'), {name: 'AI_APICallError', statusCode: 503}))).toMatchObject({origin: 'upstream', recovery_action: 'retry_request'});
    expect(executionFailure(new Error('Worker exceeded memory limit.'))).toMatchObject({recovery_action: 'pause'});
    expect(executionFailure(Object.assign(new Error('Worker exceeded CPU time limit.'), {overloaded: true}))).toMatchObject({recovery_action: 'pause'});
    expect(executionFailure(new Error('Tool failed: Worker exceeded CPU time limit.'))).not.toMatchObject({recovery_action: 'new_execution'});
  });
  it('replaces an execution for a lost platform host but never retries an overloaded one', () => {
    const inactive = 'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.';
    expect(executionFailure(new Error(inactive), 'conversation')).toMatchObject({ origin: 'local_platform', scope: 'execution', recovery_action: 'new_execution', stage: 'conversation' });
    expect(executionFailure(Object.assign(new Error('Internal error in Durable Object storage'), { retryable: true }))).toMatchObject({ recovery_action: 'new_execution' });
    expect(executionFailure(Object.assign(new Error(inactive), { retryable: true, overloaded: true }))).toBeNull();
    expect(executionFailure(Object.assign(new Error(inactive), { name: 'AI_APICallError', statusCode: 502 }))).not.toMatchObject({ recovery_action: 'new_execution' });
    expect(executionFailure(new Error(`Tool failed: ${inactive}`))).toBeNull();
  });
  it('retains a retryable upstream failure across a no-retry durable boundary', async () => {
    const failure = { origin: 'upstream', scope: 'request', recovery_action: 'retry_request',
      message: '524 error code: 524', status: 524, request_id: 'provider-request', stage: 'decision' } as const;
    const result = JSON.parse(JSON.stringify(await encodeExecutionBoundary(async () => {
      throw new ExecutionFailureError(failure);
    }, 'model_request:decision')));
    expect(result).toEqual({ failure });
    expect(() => decodeExecution(result)).toThrow(ExecutionFailureError);
  });
  it('preserves tool execution capacity failure without making it model repair feedback', async () => {
    const value = await encodeTaskStep(async () => { throw new Error(message); });
    expect(() => decodeTaskStep(value)).toThrow(message);
  });
});

it('does not classify quoted platform words in domain validation as infrastructure failure', async () => {
  const {ToolContractError} = await import('./tool-failure');
  expect(executionFailure(new ToolContractError(message,{kind:'invalid_request',effects:'none',issues:[],guidance:'Fix the field'}))).toBeNull();
});
