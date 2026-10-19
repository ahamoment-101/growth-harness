// @ts-ignore Node-only fixture.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countGscAnalytics, queryGscAnalytics, upsertGscAnalytics, upsertGscDaily } from './db';
import { gscSearchAnalyticsAll } from './lib/gsc';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`create table gsc_analytics(id text primary key,site_id text,date text,dimension text,key text,clicks integer,impressions integer,ctr real,position real,fetched_at text);
    create table gsc_daily(id text primary key,site_id text,date text,clicks integer,impressions integer,ctr real,position real,fetched_at text);`);
  let batches = 0;
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async all() { return { results: sqlite.prepare(sql).all(...values as never[]) }; },
      async first() { return sqlite.prepare(sql).get(...values as never[]) ?? null; },
      async run() { sqlite.prepare(sql).run(...values as never[]); },
    };
    return statement;
  };
  const db = { prepare, batch: async (statements: Array<{ run(): Promise<void> }>) => {
    batches++;
    for (const statement of statements) await statement.run();
  } } as unknown as D1Database;
  return { db, sqlite, get batches() { return batches; } };
}

describe('GSC analytics snapshots', () => {
  it('reads only the latest overlapping snapshot and pages through its rows', async () => {
    const f = fixture();
    const rows = [
      { id: 'old', site_id: 's', date: '2026-09-22', dimension: 'query', key: 'same', clicks: 0, impressions: 10, ctr: 0, position: 2, fetched_at: 'old' },
      { id: 'new', site_id: 's', date: '2026-09-23', dimension: 'query', key: 'same', clicks: 0, impressions: 1, ctr: 0, position: 3, fetched_at: 'new' },
      { id: 'other', site_id: 's', date: '2026-09-23', dimension: 'query', key: 'other', clicks: 1, impressions: 2, ctr: 0.5, position: 4, fetched_at: 'new' },
    ];
    await upsertGscAnalytics(f.db, rows);
    expect(await countGscAnalytics(f.db, 's', 'query', '2026-08-27', '2026-09-23')).toBe(2);
    expect((await queryGscAnalytics(f.db, 's', 'query', '2026-08-27', '2026-09-23', 1, 0)).map(row => row.key)).toEqual(['other']);
    expect((await queryGscAnalytics(f.db, 's', 'query', '2026-08-27', '2026-09-23', 1, 1)).map(row => row.impressions)).toEqual([1]);
  });

  it('writes large result sets in batches rather than one D1 call per row', async () => {
    const f = fixture();
    await upsertGscDaily(f.db, Array.from({ length: 201 }, (_, i) => ({ id: String(i), site_id: 's', date: '2026-09-23', clicks: 0, impressions: 1, ctr: 0, position: 1, fetched_at: 'now' })));
    expect(f.batches).toBe(3);
  });
});

describe('GSC API pagination', () => {
  it('requests the next offset when a page is full', async () => {
    const offsets: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { startRow: number; rowLimit: number };
      offsets.push(body.startRow);
      return new Response(JSON.stringify({ rows: body.startRow === 0 ? Array.from({ length: body.rowLimit }, (_, i) => ({ keys: [String(i)], clicks: 0, impressions: 1, ctr: 0, position: 1 })) : [{ keys: ['last'], clicks: 0, impressions: 1, ctr: 0, position: 1 }] }), { status: 200 });
    });
    const result = await gscSearchAnalyticsAll({ siteUrl: 'https://example.com/', accessToken: 'test', startDate: '2026-08-27', endDate: '2026-09-23', dimensions: ['query'] });
    expect(offsets).toEqual([0, 25_000]);
    expect(result.rows).toHaveLength(25_001);
  });
});
