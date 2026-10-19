import type { RuntimeWorkflowStep } from './env';
import { decodeExecution, encodeExecution } from './execution-failure';

/** Encode local platform refusals before Workflow's retry engine sees them.
 * Decoding happens outside step.do, so callers receive the original classification. */
export function faultAwareStep(step: RuntimeWorkflowStep): RuntimeWorkflowStep {
  return new Proxy(step, { get(target,key) {
    const value = Reflect.get(target,key);
    if (key !== 'do') return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value,target,args) : value;
    return async (name: string, configOrAction: unknown, maybeAction?: (...args: unknown[]) => Promise<unknown>) => {
      const action = (maybeAction || configOrAction) as (...args: unknown[]) => Promise<unknown>;
      const wrapped = (...args: unknown[]) => encodeExecution(() => action(...args), `workflow_step:${name}`);
      const result = await Reflect.apply(value,target,maybeAction ? [name,configOrAction,wrapped] : [name,wrapped]);
      return decodeExecution(result);
    };
  } });
}
