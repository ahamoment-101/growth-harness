import { executionFailure, ExecutionFailureError, type ExecutionFailure } from './execution-failure';
import { ZodError } from 'zod';
import { TaskPendingError, TaskStateError, taskJson } from './task-store';
import { ToolContractError, ToolExecutionError, classifyToolFailure, type ToolFailureAssessment } from './tool-failure';

type Failure = { kind: 'tool'; message: string; assessment: ToolFailureAssessment } | { kind: 'execution'; failure: ExecutionFailure } | { kind: 'contract'; message: string; details: ToolContractError['details'] }
  | { kind: 'pending' | 'state'; message: string };
type Result = { ok: true; value: unknown } | { ok: false; failure: Failure };

// Encode expected outcomes inside the durable step. Unknown exceptions still reach
// Workflow retry/reconciliation; they must not be labelled as having no effects.
export async function encodeTaskStep(action: () => Promise<unknown>, serialize: (value: unknown) => string = taskJson): Promise<string> {
  try { return serialize({ ok: true, value: await action() } satisfies Result); }
  catch (error) {
    let failure: Failure;
    if (error instanceof ToolExecutionError) failure = { kind: 'tool', message: error.message, assessment: error.assessment };
    else if (error instanceof ToolContractError) failure = { kind: 'contract', message: error.message, details: error.details };
    else if (error instanceof ZodError) failure = { kind: 'contract', message: 'Tool schema validation failed', details: {
      kind: 'invalid_request', effects: 'unknown', guidance: 'Inspect the field issues and operation state before retrying.',
      issues: error.issues.map(issue => ({ path: issue.path.map(p => typeof p === 'number' ? p : String(p)), message: issue.message })),
    } };
    else if (error instanceof TaskPendingError) failure = { kind: 'pending', message: error.message };
    else if (error instanceof TaskStateError) failure = { kind: 'state', message: error.message };
    else {
      const platform = executionFailure(error, 'tool');
      if (!platform || platform.recovery_action === 'retry_request') throw error;
      failure = { kind: 'execution', failure: platform };
    }
    return serialize({ ok: false, failure } satisfies Result);
  }
}
export function decodeTaskStep(serialized: string): unknown {
  const result = JSON.parse(serialized) as Result;
  if (result.ok) return result.value;
  const failure = result.failure;
  if (failure.kind === 'tool') throw new ToolExecutionError(failure.message, failure.assessment);
  if (failure.kind === 'execution') throw new ExecutionFailureError(failure.failure);
  if (failure.kind === 'contract') throw new ToolContractError(failure.message, failure.details);
  if (failure.kind === 'pending') throw new TaskPendingError(failure.message);
  throw new TaskStateError(failure.message);
}

/** Only explicitly retryable, replay-safe tool failures escape into Workflow retries. */
export async function encodeToolStep(action: () => Promise<unknown>, policy: { retryable: boolean; readOnly: boolean }): Promise<string> {
  try { return JSON.stringify({ ok: true, value: await action() } satisfies Result); }
  catch (error) {
    if (error instanceof TaskPendingError || error instanceof TaskStateError) {
      return encodeTaskStep(async () => { throw error; });
    }
    const platform = executionFailure(error, 'tool');
    if (platform && platform.recovery_action !== 'retry_request') {
      return encodeTaskStep(async () => { throw new ExecutionFailureError(platform); });
    }
    const assessment = { ...classifyToolFailure(error) };
    assessment.effects ??= policy.readOnly ? 'none' : 'unknown';
    if (policy.retryable && assessment.retryable && assessment.effects !== 'unknown') {
      // Workflow may retain only Error.message after its final retry. Carry the same
      // structured observation through that boundary, rather than reclassifying text.
      throw new Error(RETRY_FAILURE_PREFIX + JSON.stringify({ message: error instanceof Error ? error.message : String(error), assessment }));
    }
    return encodeTaskStep(async () => { throw new ToolExecutionError(error instanceof Error ? error.message : String(error), assessment); });
  }
}

const RETRY_FAILURE_PREFIX = 'RuntimeToolStepFailure:v1:';
/** Recover our retry envelope after Workflow has flattened an Error into its message. */
export function restoreToolStepFailure(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof ToolExecutionError) return error;
  let message = error.message;
  while (message.startsWith('Error: ')) message = message.slice(7);
  if (!message.startsWith(RETRY_FAILURE_PREFIX)) return error;
  try {
    const payload = JSON.parse(message.slice(RETRY_FAILURE_PREFIX.length)) as { message: string; assessment: ToolFailureAssessment };
    if (typeof payload.message !== 'string' || !payload.assessment || typeof payload.assessment.kind !== 'string' || typeof payload.assessment.retryable !== 'boolean') return error;
    return new ToolExecutionError(payload.message, payload.assessment);
  } catch { return error; }
}
