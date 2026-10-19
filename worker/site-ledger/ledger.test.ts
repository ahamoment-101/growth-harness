// @ts-ignore Node-only fixture.
import { DatabaseSync } from 'node:sqlite';
// @ts-ignore Node-only fixture.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { aggregateLedger, ledgerDayWindow } from './aggregate';
import { readSiteLedger, LEDGER_TTL_MS } from './index';
import { persistRuntimeJson } from '../agent-runtime/runtime-content';

const NOW = Date.parse('2026-09-20T04:00:00Z');
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../../migrations/', import.meta.url);
  for (const file of (readdirSync(directory.pathname) as string[]).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, directory).pathname, 'utf8'));
  sqlite.exec("insert into sites(id,name,ingest_url) values('s','Fixture','https://fixture.invalid'),('other','Other','https://other.invalid')");
  const queries: string[] = [];
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const execute = () => { queries.push(sql); return sqlite.prepare(sql); };
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async first() { return execute().get(...values as never[]) || null; },
      async all() { return { results: execute().all(...values as never[]) }; },
      async run() { return { meta: { changes: Number(execute().run(...values as never[]).changes) } }; },
      async batchResult() { const s = execute(); return s.columns().length ? { results: s.all(...values as never[]), meta: { changes: 0 } } : { results: [], meta: { changes: Number(s.run(...values as never[]).changes) } }; },
    };
    return statement;
  };
  const db = { prepare, batch: async (statements: Array<{ batchResult(): Promise<unknown> }>) => {
    const results = [];
    for (const statement of statements) results.push(await statement.batchResult());
    return results;
  } } as unknown as D1Database;
  const scope = { db, workspaceId: 'primary-workspace', siteId: 's' };
  const task = (id: string, output: string) => sqlite.prepare(`insert into agent_tasks(id,workspace_id,site_id,agent_id,agent_instance_id,definition_version,status,active_run_id,goal_json,output_json,max_turns,max_model_calls,max_tokens,created_at,updated_at)
    values(?,'primary-workspace','s','deep_research',?,1,'completed',?,'{}',?,0,0,0,'2026-09-19T01:00:00Z','2026-09-19T01:00:00Z')`).run(id,id,id,output);
  return { sqlite, db, scope, queries, task };
}

describe('Ledger business aggregates', () => {
  it('counts visible articles once, actual languages, active keywords and a non-overlapping GSC date window', async () => {
    const f = fixture();
    f.sqlite.prepare("insert into jobs(id,site_id,status,published_at,versions_json) values('multi','s','published','2026-09-19T05:00:00Z',?)").run(JSON.stringify([{locale:'en',slug:'one'},{locale:'pt-BR',slug:'um'}]));
    f.sqlite.exec(`insert into jobs(id,site_id,status,visibility,published_at,en_slug) values
      ('hidden','s','published','hidden','2026-09-19T05:00:00Z','hidden'),
      ('draft','s','awaiting_review','visible',null,'draft'),
      ('foreign','other','published','visible','2026-09-19T05:00:00Z','foreign'),
      ('legacy','s','published','visible','2026-09-18T15:59:59Z','legacy');
      insert into keyword_library_entries(id,workspace_id,site_id,locale,kind,name,normalized_name,data_json,revision,archived,created_at,updated_at) values
      ('k','primary-workspace','s','en','keyword','read','read','{}',1,0,'2026-09-19T01:00:00Z','now'),
      ('a','primary-workspace','s','en','keyword','archived','archived','{}',1,1,'2026-09-19T01:00:00Z','now');
      update sites set gsc_oauth_status='connected',gsc_sitemap_submit_status='success' where id='s';
      insert into gsc_daily(id,site_id,date,clicks,impressions,fetched_at) values
      ('old','s','2026-09-09',999,999,'2026-09-19'),('first','s','2026-09-10',2,10,'2026-09-19'),('last','s','2026-09-16',3,20,'2026-09-19'),('foreign','other','2026-09-17',999,999,'2026-09-19');`);
    const result = await aggregateLedger(f.scope, NOW);
    expect(result.published).toEqual({total:2,yesterday:1});
    expect(result.languages).toBe(2);
    expect(result.keywords).toEqual({total:1,yesterday:1});
    expect(result.search).toMatchObject({clicks:5,impressions:30,from:'2026-09-10',through:'2026-09-16'});
    expect(result.sitemap).toBe('submitted');
    f.sqlite.exec("update sites set gsc_oauth_status='disconnected' where id='s'");
    expect((await aggregateLedger(f.scope, NOW)).search).toBeNull();
    expect(ledgerDayWindow(NOW)).toEqual({start:'2026-09-18T16:00:00.000Z',end:'2026-09-19T16:00:00.000Z'});
  });
  it('counts actual saved research reports including chunked receipts, not completed tasks without reports', async () => {
    const f = fixture();
    f.task('inline', JSON.stringify({ report: 'Research report' }));
    f.task('empty', JSON.stringify({ report: '   ', outcome: 'completed' }));
    f.task('chunked', await persistRuntimeJson(f.db, { report: 'Evidence '.repeat(10000) }));
    f.task('large-empty', await persistRuntimeJson(f.db, { report: '', findings: 'Finding '.repeat(10000) }));
    expect((await aggregateLedger(f.scope, NOW)).research).toEqual({total:2,yesterday:2});
  });
  it('counts active document collections once and does not call revisions newly added documents', async () => {
    const f = fixture();
    for (const [id,status,date,version] of [['old','superseded','2026-09-10T00:00:00Z',1],['new','active','2026-09-19T00:00:00Z',2]] as const) {
      f.sqlite.prepare("insert into seo_strategy_versions(id,site_id,run_id,submission_operation_id,version,locale_version,status,source_locale,created_at) values(?,'s',?,?,?,? ,?,'en',?)").run(id,id,id,version,version,status,date);
      for (const kind of ['strategy','research_notes','keyword_map']) f.sqlite.prepare('insert into seo_strategy_documents(id,strategy_version_id,doc_type,body_md,created_at) values(?,?,?,?,?)').run(id+kind,id,kind,'Saved document',date);
    }
    const result = await aggregateLedger(f.scope, NOW);
    expect(result.strategies).toEqual({total:1,yesterday:0});
    expect(result.research).toEqual({total:1,yesterday:0});
  });
});

describe('Ledger snapshot cache', () => {
  it('cold-computes once; fresh visits read one cached row without aggregating', async () => {
    const f = fixture();
    const compute = vi.fn(aggregateLedger);
    const options = { now:()=>NOW, compute, waitUntil: vi.fn() };
    const first = await readSiteLedger(f.scope, options);
    expect(first.snapshot?.published.total).toBe(0);
    expect(first.refresh_failed).toBe(false);
    f.queries.length = 0;
    expect(await readSiteLedger(f.scope, options)).toEqual(first);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(f.queries).toHaveLength(1);
    expect((await readSiteLedger({...f.scope,workspaceId:'other'},options)).snapshot).toBeNull();
  });
  it('serves stale data while only one concurrent reader refreshes, then exposes the saved replacement', async () => {
    const f = fixture(); const pending: Promise<unknown>[] = [];
    const options = { now:()=>NOW, waitUntil:(p:Promise<unknown>)=>pending.push(p) };
    const first = await readSiteLedger(f.scope, options);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release=resolve; });
    const compute = vi.fn(async () => { await gate; return {...first.snapshot!,published:{total:7,yesterday:1}}; });
    const stale = {...options,now:()=>NOW+LEDGER_TTL_MS+1,compute};
    const responses = await Promise.all([readSiteLedger(f.scope,stale),readSiteLedger(f.scope,stale)]);
    expect(responses.every(r=>r.refreshing && r.snapshot?.published.total===0)).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    release(); await Promise.all(pending);
    expect((await readSiteLedger(f.scope,stale)).snapshot?.published.total).toBe(7);
  });
  it('preserves old values on failure and backs off rather than recalculating on every request', async () => {
    const f = fixture(); const pending:Promise<unknown>[]=[];
    const options={now:()=>NOW,waitUntil:(p:Promise<unknown>)=>pending.push(p)};
    await readSiteLedger(f.scope,options);
    const compute=vi.fn(async()=>{throw new Error('database temporarily unavailable');});
    const stale={...options,now:()=>NOW+LEDGER_TTL_MS+1,compute};
    await readSiteLedger(f.scope,stale);await Promise.all(pending);
    const result=await readSiteLedger(f.scope,stale);
    expect(result).toMatchObject({refresh_failed:true,refreshing:false,snapshot:{published:{total:0}}});
    expect(compute).toHaveBeenCalledTimes(1);
  });
  it('fences out an expired refresh after a newer owner has saved a result', async () => {
    const f=fixture();const pending:Promise<unknown>[]=[];
    let now=NOW;
    const options={now:()=>now,waitUntil:(p:Promise<unknown>)=>pending.push(p)};
    const initial=await readSiteLedger(f.scope,options);
    now+=LEDGER_TTL_MS+1;
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    await readSiteLedger(f.scope,{...options,compute:async()=>{await gate;return {...initial.snapshot!,languages:99};}});
    now+=120001;
    await readSiteLedger(f.scope,{...options,compute:async()=>({...initial.snapshot!,languages:2})});
    await pending[1]; release();await pending[0];
    expect((await readSiteLedger(f.scope,options)).snapshot?.languages).toBe(2);
  });
});
