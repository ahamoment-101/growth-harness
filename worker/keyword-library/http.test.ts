// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { KeywordLibrary } from './service';
import { handleKeywordLibrary } from './http';
import { lookupKeywordMetrics, lookupSerp } from './search-data';

async function fixture() {
  const f = taskTestDb();
  f.sqlite.exec("alter table sites add column workspace_id text not null default 'w'; create table topics(id text primary key,site_id text,title_hint text,status text,category text,primary_keyword text,created_at text); insert into topics values('t','s','Email guide','queued','work','email','2026-09-14');");
  f.sqlite.exec("alter table topics add column plan_json text default '{}';");
  // @ts-ignore Test-only URL.
  f.sqlite.exec(readFileSync(new URL('../../migrations/0056_keyword_library.sql', import.meta.url), 'utf8'));
  f.sqlite.exec(readFileSync(new URL('../../migrations/0075_language_only_library.sql', import.meta.url).pathname, 'utf8'));
  // @ts-ignore Test-only URL.
  f.sqlite.exec(readFileSync(new URL('../../migrations/0073_keyword_search_observations.sql', import.meta.url), 'utf8'));
  f.sqlite.exec('pragma foreign_keys=on');
  f.sqlite.exec("alter table sites add column source_locale text default 'pt-BR'; alter table sites add column translate_locales_json text default '[\"en\"]';");
  const db = f.db as unknown as D1Database;
  const service = new KeywordLibrary(db, { workspace_id: 'w', site_id: 's', locale: 'pt-BR' });
  const op = (id: string) => ({ operation_id: id, actor: { type: 'human' as const, id: 'u' }, reason: 'test' });
  const group = await service.create('topic_group', 'Work', {}, op('g'));
  const cluster = await service.create('cluster', 'Email', {}, op('c'));
  const word = await service.create('keyword', 'email', { intents: ['learn'] }, op('w'));
  await service.membership(group.target_id, cluster.target_id, true, op('gc'));
  await service.membership(cluster.target_id, word.target_id, true, op('cw'));
  await service.linkTopic(word.target_id, 't', 'Primary', op('link'));
  const call = (suffix: string, workspace: string | undefined = 'w', method = 'GET') => handleKeywordLibrary(new Request(`http://localhost/api/sites/s/keyword-library/${suffix}`, { method }), db, workspace);
  return { call, db, word, cluster, group };
}
describe('authenticated keyword library HTTP reads', () => {
  it('rejects anonymous requests even when application auth is optional', async () => {
    const f = await fixture();
    const r = await handleKeywordLibrary(new Request('http://localhost/api/sites/s/keyword-library/languages'), f.db);
    expect(r?.status).toBe(401);
    expect((await f.call('languages', 'foreign'))?.status).toBe(404);
    expect((await f.call('languages', 'w', 'POST'))?.status).toBe(405);
  });
  it('returns configured languages and no cacheable private responses', async () => {
    const { call } = await fixture(); const r = (await call('languages'))!;
    expect(await r.json()).toEqual({ languages: [{ locale: 'pt-BR' }, { locale: 'en' }] });
    expect(r.headers.get('cache-control')).toContain('no-store');
  });
  it('enriches keyword rows with direct clusters, inherited groups and topic counts', async () => {
    const { call, word, group, cluster } = await fixture();
    const result = await (await call('entries?locale=pt-BR&kind=keyword'))!.json() as any;
    expect(result.items[0].id).toBe(word.target_id);
    expect(result.items[0].parents.map((p: any) => p.id).sort()).toEqual([group.target_id, cluster.target_id].sort());
    expect(result.items[0].topic_count).toBe(1);
    const filtered = await (await call(`entries?locale=pt-BR&kind=keyword&parent_id=${group.target_id}`))!.json() as any;
    expect(filtered.items).toHaveLength(1);
  });
  it('counts descendant keywords and supports page cursors', async () => {
    const { call } = await fixture();
    const groups = await (await call('entries?locale=pt-BR&kind=topic_group'))!.json() as any;
    expect(groups.items[0].keyword_count).toBe(1);
    const first = await (await call('entries?locale=pt-BR&limit=1'))!.json() as any;
    const next = await (await call(`entries?locale=pt-BR&limit=1&after=${first.next}`))!.json() as any;
    expect(next.items[0].id).not.toBe(first.items[0].id);
  });
  it('reads real entry details, scoped topic details and complete log diffs', async () => {
    const { call, word } = await fixture();
    const detail = await (await call(`entries/${word.target_id}?locale=pt-BR`))!.json() as any;
    expect(detail.topics[0].topic_id).toBe('t');
    const topic = await (await call('topics/t?locale=pt-BR'))!.json() as any;
    expect(topic.topic.title_hint).toBe('Email guide'); expect(topic.keywords[0].id).toBe(word.target_id);
    expect((await call(`entries/${word.target_id}?locale=en`))?.status).toBe(404);
    const logs = await (await call('logs?locale=pt-BR&actor_type=human'))!.json() as any;
    expect(logs.items.length).toBeGreaterThan(0); expect(logs.items[0].changes.length).toBeGreaterThan(0);
  });
  it('rejects invalid parameters and returns configured languages even when the library is empty', async () => {
    const { call, db } = await fixture();
    expect((await call('entries'))?.status).toBe(400);
    expect((await call('entries?locale=pt-BR&limit=1000'))?.status).toBe(400);
    expect((await call('logs?locale=pt-BR&after=bad'))?.status).toBe(400);
    expect((await call('topics/missing?locale=pt-BR'))?.status).toBe(404);
    await db.prepare("insert into sites(id,workspace_id) values('empty','w')").run();
    const r = await handleKeywordLibrary(new Request('http://localhost/api/sites/empty/keyword-library/languages'), db, 'w');
    expect(await r!.json()).toEqual({ languages: [{ locale: 'pt-BR' }, { locale: 'en' }] });
  });
});

describe('recorded search data in keyword library reads', () => {
  afterEach(() => vi.unstubAllGlobals());
  const provider = (result: unknown, cost: number) => vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    status_code: 20000, cost, tasks: [{ status_code: 20000, cost, result: [result] }],
  })));
  const credentials = { login: 'l', password: 'p' };

  it('attaches the latest metrics and SERP per country to keyword rows and topic keywords', async () => {
    const { call, db } = await fixture();
    const scope = { workspace_id: 'w', site_id: 's', locale: 'pt-BR' };
    provider({ items: [{ keyword: 'email', keyword_info: { search_volume: 90, cpc: 0.3, monthly_searches: [] }, keyword_properties: { keyword_difficulty: 10 } }] }, 0.01);
    await lookupKeywordMetrics(db, credentials, scope, { country: 'BR', keywords: ['Email'] });
    provider({ items: [{ keyword: 'email', keyword_info: { search_volume: 120, cpc: 0.3, monthly_searches: [] }, keyword_properties: { keyword_difficulty: 12 } }] }, 0.01);
    const latest = await lookupKeywordMetrics(db, credentials, scope, { country: 'BR', keywords: ['email'] });
    provider({ items: [] }, 0.01);
    await lookupKeywordMetrics(db, credentials, scope, { country: 'PT', keywords: ['email'] });
    provider({ item_types: ['organic'], items: [{ type: 'organic', rank_group: 1, domain: 'a.com', url: 'https://a.com/', title: 'A' }] }, 0.002);
    await lookupSerp(db, credentials, scope, { country: 'BR', keyword: 'email' });

    const result = await (await call('entries?locale=pt-BR&kind=keyword'))!.json() as any;
    const data = result.items[0].search_data;
    expect(data.metrics.map((m: any) => [m.country, m.search_volume])).toEqual([['BR', 120], ['PT', null]]);
    expect(data.metrics[0].observed_at).toBe(latest.rows[0].metrics.observed_at);
    expect(data.serp[0].results[0].domain).toBe('a.com');
    const topic = await (await call('topics/t?locale=pt-BR'))!.json() as any;
    expect(topic.keywords[0].search_data.metrics[0].search_volume).toBe(120);
    const groups = await (await call('entries?locale=pt-BR&kind=topic_group'))!.json() as any;
    expect(groups.items[0]).not.toHaveProperty('search_data');
  });

  it('keeps search data inside its workspace, site and language', async () => {
    const { call, db } = await fixture();
    provider({ items: [{ keyword: 'email', keyword_info: { search_volume: 50 } }] }, 0.01);
    await lookupKeywordMetrics(db, credentials, { workspace_id: 'w', site_id: 's', locale: 'en' }, { country: 'US', keywords: ['email'] });
    await lookupKeywordMetrics(db, credentials, { workspace_id: 'other', site_id: 's', locale: 'pt-BR' }, { country: 'BR', keywords: ['email'] });
    const result = await (await call('entries?locale=pt-BR&kind=keyword'))!.json() as any;
    expect(result.items[0].search_data).toBeNull();
  });
});
