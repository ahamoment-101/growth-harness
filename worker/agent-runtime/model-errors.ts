/**
 * `platform_capacity` is separate from `transport` because the response differs.
 * A transport failure is worth another attempt; a platform capacity refusal is
 * the runtime declining to make the request at all, and every further attempt is
 * refused the same way in the same invocation. It is separate from
 * `invalid_output` for a more damaging reason: an invalid output is fed back to
 * the model as "repair your previous answer", and doing that when the platform
 * refused the request tells the model its work was wrong when it never ran.
 */
export type RuntimeModelFailure = {
  kind: 'transport' | 'output_truncated' | 'invalid_output' | 'platform_capacity';
  message: string;
  finishReason?: string;
};

/**
 * Refusals raised by the runtime before a request leaves the Worker. They are
 * matched on text because the platform surfaces them as plain errors with no
 * distinguishing type or status.
 */
const PLATFORM_CAPACITY_MESSAGE =
  /(?:too many (?:subrequests|API requests) by single Worker invocation|too many subrequests|exceeded (?:the )?(?:cpu|memory) limit|script will never generate a response|daily request limit|worker exceeded|too much memory)/i;

/**
 * An error raised by the Runtime's own validation of a model action, never by a
 * provider.
 *
 * Classification must recognise these by type. The transport heuristic below
 * matches on message text, and validation messages quote model- and
 * user-supplied strings — keywords, URLs, article titles. A strategy keyword
 * such as `slow network connection` or `api rate limit best practices` would
 * otherwise flip its own rejection to `transport`, which the decision loop
 * rethrows immediately: the Run dies instead of repairing a field.
 */
export class RuntimeValidationError extends Error {
  /** Survives bundling and cross-realm checks that `instanceof` alone can miss. */
  readonly isRuntimeValidationError = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeValidationError';
  }
}

export function isRuntimeValidationError(error: unknown): error is RuntimeValidationError {
  return error instanceof RuntimeValidationError
    || Boolean(error && typeof error === 'object' && (error as { isRuntimeValidationError?: unknown }).isRuntimeValidationError === true);
}

/**
 * Runs a projection and republishes any validation failure as a
 * `RuntimeValidationError`, so schema errors carrying model-supplied text
 * cannot reach the transport heuristic either. Programming errors are rethrown
 * unchanged; only declared validation failures are converted.
 */
export function runtimeValidation<T>(project: () => T): T {
  try {
    return project();
  } catch (error) {
    if (isRuntimeValidationError(error)) throw error;
    const name = String((error as { name?: unknown })?.name || '');
    if (name === 'ZodError' || name === '$ZodError') {
      throw new RuntimeValidationError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    throw error;
  }
}

const TRANSPORT_ERROR_NAMES = new Set([
  'AI_APICallError',
  'APICallError',
  'AI_EmptyResponseBodyError',
  'AI_NoOutputGeneratedError',
  'EmptyResponseBodyError',
  'NoOutputGeneratedError',
  'ModelHttpError',
  'ModelResponseError',
  'TimeoutError',
]);

export function classifyRuntimeModelFailure(error: unknown): RuntimeModelFailure {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const meta = value.modelCallMeta && typeof value.modelCallMeta === 'object'
    ? value.modelCallMeta as Record<string, unknown>
    : {};
  const name = String(value.name || (error instanceof Error ? error.name : ''));
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1500);
  const status = Number(value.statusCode ?? value.status ?? 0);
  const finishReason = String(meta.finishReason || value.finishReason || '').slice(0, 100);
  const transportMessage = /(?:response missing content|empty response|no output generated|fetch failed|network|timed? ?out|timeout|socket|connection|rate limit|provider unavailable)/i;
  // A truncated completion is decided by the provider's finish reason, so it
  // still outranks everything: the fix is asking for less, not repairing text.
  if (/(?:length|max[_ -]?tokens?|token[_ -]?limit)/i.test(finishReason)) {
    return { kind: 'output_truncated', message, finishReason };
  }
  // Type before text. Our own validation is never a transport failure, however
  // its message happens to read.
  if (isRuntimeValidationError(error)) {
    return { kind: 'invalid_output', message, ...(finishReason ? { finishReason } : {}) };
  }
  // Before the transport heuristic, because these read like neither: the request
  // never left the Worker, so there is no provider and nothing for the model to
  // repair.
  if (PLATFORM_CAPACITY_MESSAGE.test(message)) {
    return { kind: 'platform_capacity', message, ...(finishReason ? { finishReason } : {}) };
  }
  return {
    kind: TRANSPORT_ERROR_NAMES.has(name) || status >= 400 || transportMessage.test(message)
      ? 'transport'
      : 'invalid_output',
    message,
    ...(finishReason ? { finishReason } : {}),
  };
}
