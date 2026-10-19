import type { ExecutionFailure } from './execution-failure';
import type { ToolFailureAssessment } from './tool-failure';

export type RuntimeErrorAction = { action: 'feedback' } | { action: 'recover'; failure: ExecutionFailure };
export type RuntimeErrorPolicy = { id: string; matches: (failure: ToolFailureAssessment) => boolean; decide: (failure: ToolFailureAssessment) => RuntimeErrorAction };
/** Integrations may register evidenced configuration/provider recovery here.
 * Policies cannot declare business completion or request human input.
 * Empty by design. Cancellation, protocol and unknown-effect invariants are separate.
 */
export const runtimeErrorPolicies: readonly RuntimeErrorPolicy[] = [];
export function runtimeErrorAction(failure: ToolFailureAssessment): RuntimeErrorAction {
  return runtimeErrorPolicies.find(policy => policy.matches(failure))?.decide(failure) || { action: 'feedback' };
}
