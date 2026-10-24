import type { EvaluationAgreement, LearningData } from '../../shared/learning';

export function evaluateNumeric(
  agreement: EvaluationAgreement,
  values: Record<string, { value: number; unit: string }>,
): number {
  if (agreement.method !== 'numeric')
    throw new Error('This agreement requires an evidence-based rubric');
  const vars: Record<string, number> = Object.create(null);
  for (const [name, value] of Object.entries(agreement.constants)) {
    if (!Number.isFinite(value))
      throw new Error(`Non-finite constant: ${name}`);
    vars[name] = value;
  }
  for (const input of agreement.inputs) {
    const found = values[input.name];
    if (!found || !Number.isFinite(found.value) || found.unit !== input.unit)
      throw new Error(
        `Missing or incompatible input: ${input.name} (${input.unit})`,
      );
    if (Object.hasOwn(vars, input.name))
      throw new Error(`Duplicate input: ${input.name}`);
    vars[input.name] = found.value;
  }
  for (const step of agreement.steps) {
    if (Object.hasOwn(vars, step.name))
      throw new Error(`Duplicate calculation name: ${step.name}`);
    const a = vars[step.left],
      b = vars[step.right];
    if (!Number.isFinite(a) || !Number.isFinite(b))
      throw new Error('Calculation references an unavailable value');
    if (step.op === 'divide' && b === 0)
      throw new Error('Cannot divide by zero');
    const n =
      step.op === 'add'
        ? a + b
        : step.op === 'subtract'
          ? a - b
          : step.op === 'multiply'
            ? a * b
            : step.op === 'divide'
              ? a / b
              : step.op === 'min'
                ? Math.min(a, b)
                : Math.max(a, b);
    if (!Number.isFinite(n))
      throw new Error('Calculation result is not finite');
    vars[step.name] = n;
  }
  const result = vars[agreement.output];
  if (!Number.isFinite(result) || result < 0 || result > 1)
    throw new Error('Reward must be within the agreed 0–1 scale');
  return result;
}

export function utilityFromFeedback(
  rows: Array<{ reward: number | null }>,
): LearningData['utility'] {
  let score: number | null = null;
  let count = 0;
  for (const row of rows) {
    if (row.reward === null) continue;
    if (!Number.isFinite(row.reward) || row.reward < 0 || row.reward > 1)
      throw new Error('Invalid feedback reward');
    score = score === null ? row.reward : score + 0.2 * (row.reward - score);
    count++;
  }
  return { score, feedback_count: count, calculation_version: 'ema-0.2-v1' };
}

/** A frozen method can be undefined for an actual observation (for example, 0/0).
 * Preserve that gap rather than changing the agreement or manufacturing a score. */
export function calculateObservedReward(
  agreement: EvaluationAgreement,
  values: Record<string, { value: number; unit: string }>,
): { reward: number | null; reason?: string } {
  try {
    return { reward: evaluateNumeric(agreement, values) };
  } catch (error) {
    return {
      reward: null,
      reason:
        error instanceof Error
          ? error.message
          : 'Agreed calculation is unavailable',
    };
  }
}

/** Validate executable structure before freezing it; thresholds remain Agent judgments. */
export function validateAgreement(
  agreement: EvaluationAgreement,
  signals: Record<string, { unit: string; min: number; max: number }>,
) {
  if (agreement.method !== 'numeric') {
    if (!agreement.rubric.trim())
      throw new Error('A qualitative agreement needs its pre-action rubric');
    return;
  }
  const bounds = new Map<string, [number, number]>();
  for (const [key, n] of Object.entries(agreement.constants)) {
    if (!Number.isFinite(n)) throw new Error(`Non-finite constant: ${key}`);
    bounds.set(key, [n, n]);
  }
  for (const input of agreement.inputs) {
    if (bounds.has(input.name))
      throw new Error(
        `Duplicate calculation name: ${input.name}; targets belong in constants, not measured inputs`,
      );
    const signal = signals[input.name];
    if (!signal || signal.unit !== input.unit)
      throw new Error(
        `Unsupported measured input ${input.name} (${input.unit}); available signals: ${Object.keys(signals).join(', ')}`,
      );
    bounds.set(input.name, [signal.min, signal.max]);
  }
  for (const step of agreement.steps) {
    if (bounds.has(step.name))
      throw new Error(`Duplicate calculation name: ${step.name}`);
    const a = bounds.get(step.left),
      b = bounds.get(step.right);
    if (!a || !b)
      throw new Error(
        `Calculation references an unavailable value: ${!a ? step.left : step.right}`,
      );
    let range: [number, number] = [-Infinity, Infinity];
    if (step.op === 'add') range = [a[0] + b[0], a[1] + b[1]];
    if (step.op === 'subtract') range = [a[0] - b[1], a[1] - b[0]];
    if (step.op === 'min') range = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
    if (step.op === 'max') range = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    if (step.op === 'multiply' || step.op === 'divide') {
      if (step.op === 'divide' && b[0] === 0 && b[1] === 0)
        throw new Error('Cannot divide by zero');
      if (step.op === 'multiply' || b[0] > 0 || b[1] < 0) {
        const values = a.flatMap((x) =>
          b.map((y) => (step.op === 'multiply' ? x * y : x / y)),
        );
        if (values.every((v) => !Number.isNaN(v)))
          range = [Math.min(...values), Math.max(...values)];
      }
    }
    bounds.set(step.name, range);
  }
  const output = bounds.get(agreement.output);
  if (!output) throw new Error('Calculation output is not defined');
  if (output.some(Number.isNaN) || output[0] < 0 || output[1] > 1)
    throw new Error(
      'The agreed output must stay within 0–1 for available signal ranges. Express the chosen normalization with min/max arithmetic before freezing it.',
    );
}
export const GSC_SIGNALS = {
  clicks: { unit: 'count', min: 0, max: Infinity },
  impressions: { unit: 'count', min: 0, max: Infinity },
  ctr: { unit: 'ratio', min: 0, max: 1 },
  position: { unit: 'rank', min: 0, max: Infinity },
};
