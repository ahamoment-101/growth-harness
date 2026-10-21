import { classifyRuntimeModelFailure, isRuntimeValidationError } from './model-errors';
import { ModelConfigurationError } from './model-registry';

export type ExecutionFailure = {
  origin: 'configuration' | 'local_platform' | 'upstream' | 'unknown';
  scope: 'execution' | 'account' | 'request' | 'unknown';
  recovery_action: 'new_execution' | 'retry_request' | 'pause';
  message: string; status: number; request_id: string; stage: string;
};
export class ExecutionFailureError extends Error {
  readonly failure: ExecutionFailure;
  constructor(failure: ExecutionFailure) { super(failure.message); this.name = 'ExecutionFailureError'; this.failure = failure; }
}
// The platform's own wording when a Workflow or Durable Object host is replaced
// under an in-flight call; it asks the caller to reconnect or retry.
const INACTIVE_HOST_MESSAGE = /^Connection closed: this Durable Object instance is no longer active\./;

// Only a native platform refusal, without an upstream HTTP envelope, authorizes
// replacing an execution. Provider text alone is never proof of local exhaustion.
export function executionFailure(error: unknown, stage = ''): ExecutionFailure | null {
  if (error instanceof ExecutionFailureError) return error.failure;
  if (error instanceof ModelConfigurationError) return {
    origin: 'configuration', scope: 'account', recovery_action: 'pause',
    message: `${error.message} This task is paused and can resume after configuration is restored.`, status: 0, request_id: '', stage,
  };
  if (isRuntimeValidationError(error)) return null;
  const value = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  if (value.name === 'ZodError' || value.name === '$ZodError' || value.name === 'ToolContractError' || value.name === 'ToolExecutionError') return null;
  if (value.cause instanceof ExecutionFailureError) return value.cause.failure;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const status = Number(value.statusCode ?? value.status ?? 0);
  const upstream = status > 0 || Boolean(value.responseBody || value.url) || /APICallError|ModelHttpError/.test(String(value.name));
  // A lost host connection says nothing about the work itself. Durable receipts
  // let a replacement execution resume; an overloaded host must not be retried.
  const platformError = error instanceof Error && !upstream && value.overloaded !== true;
  if (platformError && (value.retryable === true || (error.name === 'Error' && INACTIVE_HOST_MESSAGE.test(message)))) {
    return { origin: 'local_platform', scope: 'execution', recovery_action: 'new_execution', message, status: 0, request_id: '', stage };
  }
  const capacity = classifyRuntimeModelFailure(error).kind === 'platform_capacity';
  if (!capacity) return null;
  const native = error instanceof Error && error.name === 'Error' && !upstream;
  const localSubrequests = native && /^Too many (?:subrequests|API requests) by single Worker invocation\./.test(message);
  // CPU allowance belongs to this execution host, like its subrequest allowance.
  // Recovery waits for host closure and reconciles effects before replacing it.
  const localCpu = native && value.overloaded !== true && /^Worker exceeded CPU (?:time )?limit\.?$/.test(message);
  const replaceExecution = localSubrequests || localCpu;
  return { origin: upstream ? 'upstream' : native ? 'local_platform' : 'unknown',
    scope: replaceExecution ? 'execution' : /daily|account/i.test(message) ? 'account' : 'unknown',
    recovery_action: replaceExecution ? 'new_execution' : upstream && (status === 429 || status >= 500) ? 'retry_request' : 'pause',
    message, status, request_id: String(value.requestId || (value.responseHeaders as Record<string,string> | undefined)?.['x-request-id'] || ''), stage };
}

export async function encodeExecution<T>(action: () => Promise<T>, stage: string): Promise<{ value: T } | { failure: ExecutionFailure }> {
  try { return { value: await action() }; }
  catch (error) {
    const failure = executionFailure(error, stage);
    if (!failure || failure.recovery_action === 'retry_request') throw error;
    return { failure };
  }
}

/** A no-retry durable boundary must return every classified failure as data.
 * Workflow does not preserve custom Error fields when a step rejects, so the
 * caller decodes this result outside step.do and routes recovery by contract. */
export async function encodeExecutionBoundary<T>(action: () => Promise<T>, stage: string): Promise<{ value: T } | { failure: ExecutionFailure }> {
  try { return { value: await action() }; }
  catch (error) {
    const failure = executionFailure(error, stage);
    if (!failure) throw error;
    return { failure };
  }
}
export function decodeExecution<T>(result: { value: T } | { failure: ExecutionFailure }): T {
  if ('failure' in result) throw new ExecutionFailureError(result.failure);
  return result.value;
}
