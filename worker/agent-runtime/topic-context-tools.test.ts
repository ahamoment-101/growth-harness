// @ts-ignore Node test fixture.
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { readTopicContext } from './topic-context-tools';
it('returns only topics bound to the task language', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`create table sites(id text, workspace_id text); insert into sites values('s','w');
    create table topics(id text,site_id text,title_hint text,primary_keyword text,status text,decision_item_id text,plan_json text,created_at text);
    insert into topics values('en-us','s','Email','email','used',null,'{"locale":"en","market":"us"}','now');
    insert into topics values('en-gb','s','Email UK','email','draft',null,'{"locale":"en","market":"gb"}','now');
    insert into topics values('unscoped','s','Old email','email','used',null,'{}','now');
    create table topic_decision_items(id text,result_id text,locale text,market text,relationship_to_existing text);
    create table topic_decision_results(id text,scope_locale text,scope_market text);
    create table jobs(id text,topic_id text,status text,published_at text,source_locale text);
    create table keyword_library_entries(id text,name text);
    insert into keyword_library_entries values('k1','write in English without translating'),('k2','translation-speak');
    create table keyword_library_topic_links(keyword_id text,topic_id text,workspace_id text,site_id text,relationship text);
    insert into keyword_library_topic_links values('k1','en-us','w','s','same_topic_variant'),('k2','en-us','w','s','section_within_topic'),('k1','en-gb','other','s','foreign');`);
  const db = { prepare(sql: string) { let values: unknown[] = []; return { bind(...args: unknown[]) { values = args; return this; }, async first() { return sqlite.prepare(sql).get(...values as never[]) || null; }, async all() { return { results: sqlite.prepare(sql).all(...values as never[]) }; } }; } } as unknown as D1Database;
  const us: any = await readTopicContext(db, 'w', 's', { locale: 'en' }, { section: 'inventory', limit: 20, offset: 0 });
  expect(us.items.map((item: any) => item.topic_id)).toEqual(['en-us', 'en-gb']);
  expect(us.items[0]).toMatchObject({ scope_locale: 'en', linked_keywords: [
    { keyword: 'translation-speak', relationship: 'section_within_topic' },
    { keyword: 'write in English without translating', relationship: 'same_topic_variant' },
  ] });
  const br: any = await readTopicContext(db, 'w', 's', { locale: 'pt-BR' }, { section: 'inventory', limit: 20, offset: 0 });
  expect(br.items).toEqual([]);
});

it('shows whether an earlier research request started strategy research and how it ended', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`create table sites(id text, workspace_id text); insert into sites values('s','w');
    create table topic_decision_results(id text,workspace_id text,site_id text,scope_locale text,scope_market text,status text,created_at text,research_run_id text,research_dispatch_error text);
    insert into topic_decision_results values('asked','w','s','en','us','research_needed','1','strategy-1',''),('pending','w','s','en','us','research_needed','2','','');
    create table agent_tasks(id text,status text,outcome text,reason text); insert into agent_tasks values('strategy-1','completed','no_change','Library updated for Slack messages');
    create table agent_runs(id text,workspace_id text,site_id text,agent_id text,status text,output_json text,created_at text,summary_json text);`);
  const db = { prepare(sql: string) { let values: unknown[] = []; return { bind(...args: unknown[]) { values = args; return this; }, async first() { return sqlite.prepare(sql).get(...values as never[]) || null; }, async all() { return { results: sqlite.prepare(sql).all(...values as never[]) }; } }; } } as unknown as D1Database;
  const history: any = await readTopicContext(db, 'w', 's', { locale: 'en' }, { section: 'history', limit: 20, offset: 0 });
  expect(history.items).toMatchObject([
    { id: 'pending', research_run_id: '', research_task_status: null },
    { id: 'asked', research_run_id: 'strategy-1', research_task_status: 'completed', research_task_outcome: 'no_change', research_task_reason: 'Library updated for Slack messages' },
  ]);
});
