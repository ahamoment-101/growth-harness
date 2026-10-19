// @ts-ignore Node test-only modules.
import { DatabaseSync } from 'node:sqlite';
// @ts-ignore Node test-only modules.
import { readFileSync, readdirSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';

/** Full production schema (every migration) behind a minimal D1 shim that records each prepared statement. */
export function schemaTestDb() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../../migrations/', import.meta.url).pathname;
  for (const file of (readdirSync(directory) as string[]).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(`${directory}${file}`, 'utf8') as string);
  const seen = new Set<string>();
  /** How many times each statement was executed. */
  const runs = new Map<string, number>();
  const prepare = (sql: string) => {
    seen.add(sql);
    const count = () => runs.set(sql, (runs.get(sql) ?? 0) + 1);
    let values: unknown[] = [];
    const statement = {
      bind: (...args: unknown[]) => { values = args; return statement; },
      first: async <T>(column?: string) => { count(); const row = sqlite.prepare(sql).get(...values as never[]) as Record<string, unknown> | undefined; return ((column ? row?.[column] : row) ?? null) as T; },
      all: async () => { count(); return { results: sqlite.prepare(sql).all(...values as never[]) }; },
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values as never[]).changes) } }),
    };
    return statement;
  };
  const db = { prepare, batch: async (s: Array<{ run(): Promise<unknown> }>) => { const out = []; for (const x of s) out.push(await x.run()); return out; } } as unknown as D1Database;
  /** Insert a row, filling every other NOT NULL column without a default with an empty value. */
  const insert = (table: string, values: Record<string, unknown>) => {
    const columns = sqlite.prepare(`pragma table_info(${JSON.stringify(table)})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
    const row: Record<string, unknown> = {};
    for (const c of columns) if (c.notnull && c.dflt_value === null && !(c.pk && /int/i.test(c.type))) row[c.name] = /int|real|num/i.test(c.type) ? 0 : '';
    Object.assign(row, values);
    const keys = Object.keys(row);
    sqlite.prepare(`insert into ${table}(${keys.join(',')}) values(${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]) as never[]);
  };
  const executions = (fragment: string) => [...runs].filter(([sql]) => sql.includes(fragment)).reduce((n, [, c]) => n + c, 0);
  return { sqlite, db, seen, insert, executions };
}
