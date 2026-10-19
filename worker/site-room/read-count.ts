import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

/**
 * D1 as the room's read paths use it (prepare/bind/all/first), adding each statement's exact rows_read
 * to `count`. D1 analytics are sampled; these totals appear in the room's log lines instead.
 * `first` goes through `all`, which is what D1 executes for it anyway.
 */
export function countReads(db: D1Database, count: (rows: number) => void): D1Database {
  const inner = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async () => { const result = await statement.all(); count(result.meta.rows_read ?? 0); return result; },
      first: async (column?: string) => {
        const result = await statement.all<Record<string, unknown>>(); count(result.meta.rows_read ?? 0);
        const row = result.results[0];
        return column ? row?.[column] ?? null : row ?? null;
      },
      run: async () => { const result = await statement.run(); count(result.meta.rows_read ?? 0); return result; },
      raw: (...args: Parameters<D1PreparedStatement["raw"]>) => statement.raw(...args),
    };
    inner.set(wrapped, statement);
    return wrapped as unknown as D1PreparedStatement;
  };
  return {
    prepare: (query: string) => wrap(db.prepare(query)),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = await db.batch(statements.map(statement => inner.get(statement) ?? statement));
      for (const result of results) count(result.meta.rows_read ?? 0);
      return results;
    },
  } as unknown as D1Database;
}
