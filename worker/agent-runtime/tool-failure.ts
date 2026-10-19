import { ZodError } from 'zod';

export class ToolContractError extends Error {
  constructor(message: string, readonly details: {
    kind: 'invalid_request' | 'state_conflict' | 'unknown_outcome';
    issues: Array<{ path: Array<string | number>; message: string }>;
    effects: 'none' | 'preserved' | 'unknown';
    guidance: string;
  }) { super(message); this.name = 'ToolContractError'; }
}

/** Transport established failure facts; business recovery choices belong to the Agent. */

export type ToolFailureKind =
  | 'quota_exhausted'
  | 'not_authorized'
  | 'not_configured'
  | 'invalid_request'
  | 'invalid_output'
  | 'rate_limited'
  | 'transient'
  | 'state_conflict'
  | 'unknown_outcome'
  | 'unknown';

export type ToolFailureAssessment = {
  kind: ToolFailureKind;
  /** Eligibility for automatic transport retry, subject to effect safety; not a ban on Agent repair. */
  retryable: boolean;
  guidance: string;
  issues?: Array<{ path: Array<string | number>; message: string }>;
  effects?: string;
  observation?: { requestId: string; stopReason: string; text: string };
};

export class ToolExecutionError extends Error {
  constructor(message: string, readonly assessment: ToolFailureAssessment) { super(message); this.name = 'ToolExecutionError'; }
}

const GUIDANCE: Record<ToolFailureKind, string> = {
  unknown: 'The cause and retry conditions are not established. Saved effects must be considered before another operation.',
  state_conflict: 'The observed state differs from the state required by the operation.',
  unknown_outcome: 'The original operation must be reconciled before another effect can be attempted.',
  quota_exhausted: 'The provider reports insufficient account capacity for this request. Capacity availability may change.',
  not_authorized: 'The provider rejected authorization for this request.',
  not_configured: 'A required integration configuration is unavailable.',
  invalid_output: 'The read-only response did not meet its output contract. Its text and receipt are preserved as unvalidated evidence.',
  invalid_request: 'The request violates the reported input contract; see the affected fields and constraints.',
  rate_limited: 'The provider returned HTTP 429. A later request may be accepted; effect safety is checked separately.',
  transient: 'The transport reports a temporary failure; effect safety is checked separately.',
};

const RETRYABLE: Record<ToolFailureKind, boolean> = {
  unknown: false,
  quota_exhausted: false,
  not_authorized: false,
  not_configured: false,
  invalid_request: false,
  invalid_output: false,
  state_conflict: false,
  unknown_outcome: false,
  rate_limited: true,
  transient: true,
};

export function classifyToolFailure(error: unknown): ToolFailureAssessment {
  if (error instanceof ToolContractError) return { ...error.details, retryable: false };
  if (error instanceof ZodError) return { kind: 'invalid_request', effects: 'none', retryable: false, guidance: GUIDANCE.invalid_request, issues: error.issues.map(issue => ({ path: issue.path.map(part => typeof part === 'number' ? part : String(part)), message: issue.message })) };
  if (error instanceof ToolExecutionError) return error.assessment;
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = value.statusCode ?? value.status;
  const cause = value.cause && typeof value.cause === 'object' ? value.cause as Record<string, unknown> : {};
  const code = value.code ?? cause.code;
  // HTTP status and transport codes describe execution conditions. Arbitrary
  // message text is evidence for the Agent, not authority to classify a remedy.
  const kind: ToolFailureKind = status === 429 ? 'rate_limited'
    : status === 401 || status === 403 ? 'not_authorized'
    : typeof status === 'number' && status >= 500 && status <= 599 ? 'transient'
    : ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(code)) ? 'transient'
    : 'unknown';
  return { kind, retryable: RETRYABLE[kind], guidance: GUIDANCE[kind] };
}

/**
 * The failure observation an Agent reads.
 *
 * `repeat_failures` counts this tool's failures of the same kind so far, so a
 * wall the Agent has already hit twice does not read like a first attempt.
 */
export function toolFailureObservation(input: {
  error: unknown;
  toolName: string;
  priorFailures: Record<string, number>;
}): Record<string, unknown> {
  const assessment = classifyToolFailure(input.error);
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return {
    accepted: false,
    error: message.slice(0, 1200),
    failure_kind: assessment.kind,
    retryable: assessment.retryable,
    repeat_failures: (input.priorFailures[`${input.toolName}:${assessment.kind}`] || 0) + 1,
    guidance: assessment.guidance,
    issues: assessment.issues,
    effects: assessment.effects,
    observation: assessment.observation,
  };
}

/** Records a failure so later observations can report how often it has happened. */
export function recordToolFailure(
  priorFailures: Record<string, number>,
  toolName: string,
  error: unknown,
): ToolFailureAssessment {
  const assessment = classifyToolFailure(error);
  const key = `${toolName}:${assessment.kind}`;
  priorFailures[key] = (priorFailures[key] || 0) + 1;
  return assessment;
}
