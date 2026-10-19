// @ts-ignore Node-only migration fixture.
import { DatabaseSync } from 'node:sqlite';
// @ts-ignore Node-only migration fixture.
import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('pragma foreign_keys=on');
  const directory = new URL('../../migrations/', import.meta.url);
  const read = (file: string) => readFileSync(new URL(file, directory).pathname, 'utf8');
  for (const file of (readdirSync(directory.pathname) as string[]).filter(file => file.endsWith('.sql') && file < '0075').sort()) db.exec(read(file));
  db.exec(`insert into sites(id,name,ingest_url) values('s','Fixture','https://fixture.invalid');
    insert into topics(id,site_id,topic_key,title_hint,category,primary_keyword,plan_json) values('t','s','email','Email','guide','email','{"locale":"en","market":"global","rationale":"Keep this"}');
    insert into jobs(id,site_id,topic_id,plan_json) values('j','s','t','{"locale":"en","market":"global","scope":{"locale":"en","market":"global"}}');
    insert into keyword_library_entries(id,workspace_id,site_id,locale,market,kind,name,normalized_name,data_json,revision,created_at,updated_at) values
    ('k','primary-workspace','s','en','global','keyword','email','email','{}',3,'now','now'),
    ('g','primary-workspace','s','en','global','cluster','Writing','writing','{}',2,'now','now'),
    ('p','primary-workspace','s','pt-BR','BR','keyword','email','email','{}',1,'now','now');
    insert into keyword_library_memberships values('g','k','primary-workspace','s','en','global','cluster','keyword');
    insert into topic_decision_results(id,workspace_id,site_id,run_id,submission_operation_id,strategy_version,decision_type,status,requested_count,scope_locale,scope_market,created_at,updated_at)
    values('r','primary-workspace','s','run','op',0,'topic_group','draft',1,'en','global','now','now');
    insert into topic_decision_items(id,result_id,strategy_keyword_id,keyword_id,topic_key,title_direction,primary_keyword,content_type,locale,market,search_intent,group_role,rationale,hypothesis,sort_order,created_at,library_keyword_id)
    values('i','r','','','email','Email','email','GUIDE','en','global','learn','guide','reason','hypothesis',0,'now','k');
    insert into keyword_library_logs values('log','primary-workspace','s','en','global','write','{"scope":{"locale":"en","market":"global"}}','{"type":"human","id":"u"}','create','k','{}','{}','[]','{"target_id":"k"}','reason','now');`);
  return { db, migrate: () => {
    db.exec('begin');
    try { db.exec(read('0075_language_only_library.sql')); db.exec(read('0076_language_only_topics_strategy.sql')); db.exec('commit'); }
    catch (error) { db.exec('rollback'); throw error; }
  } };
}
it('removes the partition while preserving IDs, locale, relationships, cascade children and immutable receipts', () => {
  const { db, migrate } = fixture();
  const receipt = db.prepare('select request_json,receipt_json from keyword_library_logs').get();
  migrate();
  expect(db.prepare('select id,locale,revision from keyword_library_entries order by id').all()).toEqual([
    { id: 'g', locale: 'en', revision: 2 }, { id: 'k', locale: 'en', revision: 3 }, { id: 'p', locale: 'pt-BR', revision: 1 },
  ]);
  expect(db.prepare('select parent_id,child_id from keyword_library_memberships').get()).toEqual({ parent_id: 'g', child_id: 'k' });
  expect(db.prepare('select id,result_id,library_keyword_id from topic_decision_items').get()).toEqual({ id: 'i', result_id: 'r', library_keyword_id: 'k' });
  expect(db.prepare('select request_json,receipt_json from keyword_library_logs').get()).toEqual(receipt);
  for (const table of ['keyword_library_entries', 'keyword_library_memberships', 'keyword_library_topic_links', 'keyword_library_logs', 'topic_decision_results', 'topic_decision_items', 'seo_keywords', 'seo_research_sources']) {
    expect(db.prepare(`pragma table_info(${table})`).all().map((row: any) => row.name)).not.toContain('market');
    expect(db.prepare(`pragma table_info(${table})`).all().map((row: any) => row.name)).not.toContain('scope_market');
  }
  expect(JSON.parse((db.prepare("select plan_json from topics where id='t'").get() as any).plan_json)).toEqual({ locale: 'en', rationale: 'Keep this' });
  expect(JSON.parse((db.prepare("select plan_json from jobs where id='j'").get() as any).plan_json)).toEqual({ locale: 'en', scope: { locale: 'en' } });
  expect(db.prepare('pragma foreign_key_check').all()).toEqual([]);
  expect(() => db.exec("delete from keyword_library_logs where id='log'")).toThrow('immutable');
});
it('rolls back conflicting names without silently merging or discarding existing records', () => {
  const { db, migrate } = fixture();
  db.exec(`insert into keyword_library_entries select 'duplicate',workspace_id,site_id,locale,'US',kind,name,normalized_name,data_json,revision,archived,created_at,updated_at from keyword_library_entries where id='k'`);
  expect(migrate).toThrow('UNIQUE');
  expect(db.prepare('select count(*) as n from keyword_library_entries').get()).toEqual({ n: 4 });
  expect(db.prepare('select library_keyword_id from topic_decision_items').get()).toEqual({ library_keyword_id: 'k' });
  expect(db.prepare('pragma foreign_key_check').all()).toEqual([]);
});
