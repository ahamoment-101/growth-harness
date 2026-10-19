import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';

type Counts = { fetch: number; d1: number; r2: number; statements: number; id: string };
const context = new AsyncLocalStorage<Counts>();
export const observedFetch: typeof fetch = (input, init) => {
  const counts = context.getStore(); if (counts) counts.fetch++;
  return fetch(input, init);
};
const raw = new WeakMap<object, object>();
function countBinding<T extends object>(target: T, kind: 'd1' | 'r2', methods: string[]): T {
  const proxy = new Proxy(target, { get(object, key) {
    const value = Reflect.get(object, key);
    if (typeof value !== 'function') return value;
    if (key === 'prepare' || key === 'bind') return (...args: unknown[]) => countBinding(Reflect.apply(value, object, args), kind, ['first','all','run','raw']);
    return (...args: unknown[]) => {
      const counts = context.getStore();
      if (methods.includes(String(key)) && counts) {
        counts[kind]++;
        if (kind === 'd1') counts.statements += key === 'batch' ? (args[0] as unknown[]).length : 1;
      }
      if (key === 'batch') args[0] = (args[0] as object[]).map(statement => raw.get(statement) || statement);
      return Reflect.apply(value, object, args);
    };
  } });
  raw.set(proxy, target); return proxy;
}
export function accountedEnvironment(env: RuntimeAgentEnv): RuntimeAgentEnv {
  return { ...env, DB: countBinding(env.DB, 'd1', ['batch','exec']),
    ...(env.RESEARCH_BUCKET ? { RESEARCH_BUCKET: countBinding(env.RESEARCH_BUCKET, 'r2', ['get','put','head','list','delete']) } : {}) };
}
// Samples share the existing transaction. A snapshot overwrites the same execution
// segment, never adds cumulative counters twice. Crashed segments remain incomplete.
export function requestSampleStatement(db: D1Database, runId: string, complete = false, pendingStatements = 0): D1PreparedStatement[] {
  const counts = context.getStore(); if (!counts) return [];
  return [db.prepare(`insert into agent_request_samples(run_id,step_key,fetch_calls,d1_calls,r2_calls,sql_statements,complete,recorded_at)
    values(?,?,?,?,?,?,?,?) on conflict(run_id,step_key) do update set fetch_calls=excluded.fetch_calls,
    d1_calls=excluded.d1_calls,r2_calls=excluded.r2_calls,sql_statements=excluded.sql_statements,
    complete=excluded.complete,recorded_at=excluded.recorded_at`)
    .bind(runId, `execution:${counts.id}`, counts.fetch, counts.d1 + 1, counts.r2, counts.statements + pendingStatements + 1,
      complete ? 1 : 0, new Date().toISOString())];
}
// Step replay is observed by the outer execution context, with no per-step write.
export function accountedStep(step: RuntimeWorkflowStep, _env: RuntimeAgentEnv, _runId: string): RuntimeWorkflowStep {
  const counts = context.getStore();
  if (!counts) return step;
  return new Proxy(step, { get(target,key) {
    const value = Reflect.get(target,key);
    if (key !== 'do') return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value,target,args) : value;
    return (name: string, configOrAction: unknown, maybeAction?: (...args: unknown[]) => Promise<unknown>) => {
      const action = (maybeAction || configOrAction) as (...args: unknown[]) => Promise<unknown>;
      const wrapped = (...args: unknown[]) => context.run(counts, () => action(...args));
      return Reflect.apply(value,target,maybeAction ? [name,configOrAction,wrapped] : [name,wrapped]);
    };
  } });
}
export async function accountExecutionBoundary<T>(env: RuntimeAgentEnv, step: RuntimeWorkflowStep, runId: string, action: () => Promise<T>): Promise<T> {
  const counts: Counts = {fetch: 0,d1: 0,r2: 0,statements: 0,id: crypto.randomUUID()};
  return context.run(counts, async () => {
    let complete = false;
    try { const result = await action(); complete = true; return result; }
    finally {
      try {
        await (step as unknown as { do(name: string, config: unknown, action: () => Promise<void>): Promise<unknown> }).do('request-accounting-between-steps', { retries: { limit: 0, delay: '1 second' }, timeout: '10 seconds' }, () => context.run(counts, async () => {
          const statements = requestSampleStatement(env.DB, runId, complete);
          if (statements.length) await env.DB.batch(statements);
        }));
      } catch (error) { console.error('Execution accounting incomplete', runId, String(error)); }
    }
  });
}
