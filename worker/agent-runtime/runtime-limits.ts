/**
 * Physical execution limits owned by the Runtime.
 *
 * Every value here describes what the platform or a provider can withstand, not
 * what a business Agent wants. Agents must not override them and must not keep
 * private copies: a step timeout is a property of Workflows, and a request
 * timeout is a property of the model endpoint. Cumulative consumption is observed, not a lifetime stopping condition.
 * The business loop uses autonomous 30-decision audits.
 *
 * What lives here is what more than one module must agree on. A window used by
 * a single module belongs to that module — a wait that is part of a protocol is
 * a property of the protocol, not of the platform.
 *
 * There is deliberately no total-runtime ceiling. Durable execution decouples
 * elapsed time from CPU use: idle waits do not consume CPU; reconciliation
 * polls, steps and storage still incur their respective usage. Every wait is bounded by
 * its own step, sleep, or event timeout. A wall-clock cap could only fire while
 * a Run was actively making progress, so it killed healthy slow Runs while
 * never catching a stuck one. Long tasks are a supported outcome.
 */
import type { WorkflowStepConfig } from 'cloudflare:workers';

/**
 * One physical model request. Exceeding it means the single generation is too
 * large, which is fixed by asking for less in one call — not by waiting longer.
 */
export const RUNTIME_MODEL_REQUEST_TIMEOUT_MS = 240_000;

/** Slack added on top of an operation's own timeout so the step observes the
 * operation's failure instead of racing it. */
const STEP_SLACK_MS = 30_000;

function stepSeconds(milliseconds: number): `${number} seconds` {
  return `${Math.max(1, Math.ceil(milliseconds / 1000))} seconds`;
}

const NO_RETRY = { limit: 0, delay: '1 second', backoff: 'constant' } as const;
const RETRY_ONCE = { limit: 1, delay: '5 seconds', backoff: 'constant' } as const;

/**
 * One step carries exactly one physical model request. Provider attempts are
 * separate steps, so a stalled attempt costs one attempt rather than the Run,
 * and no step ever has to stay open longer than a single request.
 */
export const MODEL_ATTEMPT_STEP: WorkflowStepConfig = {
  retries: NO_RETRY,
  timeout: stepSeconds(RUNTIME_MODEL_REQUEST_TIMEOUT_MS + STEP_SLACK_MS),
};

/** Cheap D1 read checking child readiness. */
export const READINESS_CHECK_STEP: WorkflowStepConfig = { retries: NO_RETRY, timeout: '10 seconds' };

/** D1 bookkeeping: events, audit rows, decision persistence. Safe to repeat. */
export const BOOKKEEPING_STEP: WorkflowStepConfig = { retries: RETRY_ONCE, timeout: '1 minute' };

/**
 * Step config for an inline tool, derived from the tool's own declared timeout
 * and retryability. The slack matters: without it the step and the tool's own
 * abort expire together, and a tool timeout is killed by the step before it can
 * report what went wrong.
 */
export function toolCallStep(toolTimeoutMs: number, retryable: boolean): WorkflowStepConfig {
  return {
    retries: retryable ? RETRY_ONCE : NO_RETRY,
    timeout: stepSeconds(toolTimeoutMs + STEP_SLACK_MS),
  };
}

