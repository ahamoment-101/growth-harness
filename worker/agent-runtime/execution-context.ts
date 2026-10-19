import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { RuntimeAgentEnv } from './env';

/** Immutable authority captured at dispatch, never reconstructed from live state. */
export type RuntimeExecutionContext = Readonly<{
  taskId: string;
  runId: string;
  executionId: string;
  epoch: number;
}>;
const authority = Symbol('runtime.execution');
const unwrapped = Symbol('runtime.statement');
type ScopedDatabase = D1Database & { [authority]?: RuntimeExecutionContext };
type ScopedStatement = D1PreparedStatement & { [unwrapped]?: D1PreparedStatement };

export function executionContext(db: D1Database): RuntimeExecutionContext | undefined {
  return (db as ScopedDatabase)[authority];
}

/** All writes through this capability are fenced atomically, including domain SQL.
 * Reads do not grant authority. SQL batches preserve their transaction boundary.
 * D1 exec is deliberately unavailable: Runtime migrations are never agent actions.
 */
export function executionDatabase(db: D1Database, context: RuntimeExecutionContext): D1Database {
  const captured = Object.freeze({ ...context });
  const existing = executionContext(db);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(captured)) throw new Error('Cannot replace execution authority');
    return db;
  }
  const guard = () => db.prepare('insert into agent_runtime_write_guards(task_id,run_id,execution_id,epoch) values(?,?,?,?)')
    .bind(captured.taskId, captured.runId, captured.executionId, captured.epoch);
  const raw = (statement: D1PreparedStatement) => (statement as ScopedStatement)[unwrapped] || statement;
  const batch = async (statements: D1PreparedStatement[]) => (await db.batch([guard(), ...statements.map(raw)])).slice(1);
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    // WITH may contain writes; fence it too. Normal SELECT reads need no write transaction.
    const readOnly = /^\s*(?:select|explain)\b/i.test(sql);
    return new Proxy(statement, {
      get(target, key) {
        if (key === unwrapped) return target;
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === 'run') return async () => (await batch([target]))[0];
        if (!readOnly && key === 'all') return async () => (await batch([target]))[0];
        if (!readOnly && key === 'first') return async (column?: string) => {
          const result = (await batch([target]))[0].results[0] as Record<string, unknown> | undefined;
          return column ? result?.[column] ?? null : result ?? null;
        };
        if (!readOnly && key === 'raw') return () => { throw new Error('Use a fenced D1 result for Runtime writes'); };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === authority) return captured;
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === 'batch') return batch;
      if (key === 'exec' || key === 'withSession') return () => { throw new Error('Runtime database capability cannot escape its execution fence'); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function executionEnvironment(env: RuntimeAgentEnv, context: RuntimeExecutionContext): RuntimeAgentEnv {
  return { ...env, execution: Object.freeze({ ...context }), DB: executionDatabase(env.DB, context),
    // Receipt-only capability: a late response may identify an already claimed job,
    // but cannot revive a Task or grant its old executor business write authority.
    recordFirecrawlIdentity: async (taskId, jobId) => {
      if (taskId !== context.taskId) throw new Error('External receipt task mismatch');
      await env.DB.prepare(`update firecrawl_research_jobs set job_id=?,status=case when status='cancel_requested'
        or exists(select 1 from agent_tasks where id=? and status in ('completed','cancelled')) then 'cancel_requested' else 'processing' end,updated_at=?
        where task_id=? and submission_execution_id=? and job_id='' and status in ('submitting','unknown','cancel_requested')`)
        .bind(jobId, taskId, new Date().toISOString(), taskId, context.executionId).run();
    },
  };
}
