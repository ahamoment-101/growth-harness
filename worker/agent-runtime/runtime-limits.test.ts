import { describe, expect, it } from 'vitest';
import { AGENT_IDS, agentDefinition } from './definitions';
import {
  READINESS_CHECK_STEP,
  MODEL_ATTEMPT_STEP,
  RUNTIME_MODEL_REQUEST_TIMEOUT_MS,
  toolCallStep,
} from './runtime-limits';

const UNIT_MS: Record<string, number> = {
  second: 1_000, minute: 60_000, hour: 3_600_000,
};

function windowMs(timeout: unknown): number {
  if (typeof timeout === 'number') return timeout;
  const [amount, unit] = String(timeout).split(' ');
  const scale = UNIT_MS[unit.replace(/s$/, '')];
  if (!scale) throw new Error(`Unsupported step duration: ${String(timeout)}`);
  return Number(amount) * scale;
}

describe('runtime execution limits', () => {
  it('lets an operation abort itself before its step is killed', () => {
    // The inner abort must win, otherwise the failure arrives as a dead step
    // with no attributable cause and no trace row.
    expect(windowMs(MODEL_ATTEMPT_STEP.timeout)).toBeGreaterThan(RUNTIME_MODEL_REQUEST_TIMEOUT_MS);
    expect(windowMs(toolCallStep(60_000, true).timeout)).toBeGreaterThan(60_000);
    expect(windowMs(toolCallStep(16 * 60_000, false).timeout)).toBeGreaterThan(16 * 60_000);
  });

  it('derives tool step retries from the tool contract rather than the call site', () => {
    expect(toolCallStep(30_000, true).retries?.limit).toBe(1);
    expect(toolCallStep(30_000, false).retries?.limit).toBe(0);
  });

  it('never retries a budget check, so a budget stays a single deterministic gate', () => {
    expect(READINESS_CHECK_STEP.retries?.limit).toBe(0);
  });

  it('gives no Agent a ceiling on how long its Run may take', () => {
    // The durable business session has no elapsed-time or cumulative usage ceiling.
    for (const agentId of AGENT_IDS) {
      const policy = agentDefinition(agentId).runPolicy as Record<string, unknown>;
      const timeLimits = Object.keys(policy).filter((key) => /timeout|deadline|maxDuration|elapsed/i.test(key));
      expect(timeLimits).toEqual([]);
      expect(policy).not.toHaveProperty('maxTotalTokens');
      expect(policy).not.toHaveProperty('maxModelCalls');
      expect(policy).not.toHaveProperty('maxDecisionTurns');
    }
  });
});
