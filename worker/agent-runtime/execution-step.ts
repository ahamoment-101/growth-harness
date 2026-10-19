import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { EXECUTION_STEP_LIMIT, ExecutionHandoff } from './runtime-executions';

export async function checkExecutionCapacity(env: RuntimeAgentEnv): Promise<void> {
  if (!env.execution) return;
  const state = await env.DB.prepare('select durable_steps from agent_runtime_executions where id=?')
    .bind(env.execution.executionId).first<{ durable_steps: number }>();
  if (!state || state.durable_steps < EXECUTION_STEP_LIMIT) return;
  const unsettled = await env.DB.prepare(`select 1 where exists(select 1 from agent_task_model_reservations where task_id=? and status='running')
    or exists(select 1 from agent_task_operations where task_id=? and (status='unknown' or (status='running' and json_extract(external_json,'$.replay_safety')='unknown')))`)
    .bind(env.execution.taskId, env.execution.taskId).first();
  if (!unsettled) throw new ExecutionHandoff();
}

/** `afterStep` runs once each durable step is recorded (used to wake live views; must not throw). */
export function executionStep(step: RuntimeWorkflowStep, env: RuntimeAgentEnv, afterStep?: () => Promise<void>): RuntimeWorkflowStep {
  if (!env.execution) return step;
  return new Proxy(step, { get(target, key) {
    const value = Reflect.get(target, key);
    if (!['do','sleep','sleepUntil','waitForEvent'].includes(String(key))) return typeof value === 'function' ? value.bind(target) : value;
    return async (name: string, ...args: unknown[]) => {
      await checkExecutionCapacity(env);
      const result = await Reflect.apply(value, target, [name, ...args]);
      await env.DB.batch([
        env.DB.prepare('insert or ignore into agent_runtime_execution_steps(execution_id,step_key) values(?,?)').bind(env.execution!.executionId, `${String(key)}:${name}`),
        env.DB.prepare('update agent_runtime_executions set durable_steps=durable_steps+1 where id=? and changes()=1').bind(env.execution!.executionId),
      ]);
      await afterStep?.();
      return result;
    };
  } });
}
