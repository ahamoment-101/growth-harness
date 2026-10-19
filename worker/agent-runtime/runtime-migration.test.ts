// @ts-ignore Node test-only modules.
import { DatabaseSync } from 'node:sqlite';
// @ts-ignore Node test-only modules.
import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { URL } from 'node:url';
import { unstable_splitSqlQuery } from 'wrangler';

it('preserves the full schema when Wrangler splits migrations for remote execution', () => {
  const reference = new DatabaseSync(':memory:');
  const remote = new DatabaseSync(':memory:');
  const directory = new URL('../../migrations/', import.meta.url);
  const files = readdirSync(directory).filter((file: string) => file.endsWith('.sql')).sort();
  try {
    for (const file of files) {
      const sql = readFileSync(new URL(file, directory), 'utf8');
      reference.exec(sql);
      for (const statement of unstable_splitSqlQuery(sql)) remote.prepare(statement).run();
      const schema = 'select type, name, tbl_name from sqlite_master order by type, name';
      expect(remote.prepare(schema).all(), file).toEqual(reference.prepare(schema).all());
      const tables = reference.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>;
      for (const { name } of tables) {
        expect(remote.prepare(`pragma table_xinfo("${name}")`).all(), `${file}: ${name}`)
          .toEqual(reference.prepare(`pragma table_xinfo("${name}")`).all());
      }
    }
  } finally {
    reference.close();
    remote.close();
  }
});

it('preserves nonempty formal artifact graphs and source IDs when Runtime history is removed', () => {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../../migrations/', import.meta.url);
  const files = readdirSync(directory).filter((file: string) => file.endsWith('.sql')).sort();
  for (const file of files.filter((file: string) => file < '0052')) db.exec(readFileSync(new URL(file,directory),'utf8'));
  const seeded = new Map<string,string>();
  const overrides: Record<string,Record<string,unknown>> = {
    sites:{id:'site',name:'Protected business',ingest_url:'https://example.invalid'},
    agent_runs:{id:'run',agent_id:'strategy_research',trigger:'manual',status:'succeeded',workspace_id:'primary-workspace'},
    seo_strategy_runs:{id:'strategy-run'},
    seo_strategy_versions:{id:'version',status:'active',source_locale:'en',locale_version:1},
    topic_decision_results:{decision_type:'topic_group',status:'rejected',workspace_id:'primary-workspace'},
    content_production_groups:{status:'awaiting_review',workspace_id:'primary-workspace'},
    jobs:{status:'drafting'},
    content_artifacts:{status:'candidate'},
    content_review_interactions:{kind:'child_submitted',actor_type:'agent'},
    agent_memories:{agent_id:'strategy_research',kind:'research_evidence',workspace_id:'primary-workspace'},
  };
  function seed(table:string): string {
    if(seeded.has(table)) return seeded.get(table)!;
    const existing=db.prepare(`select * from ${table} limit 1`).get() as Record<string,unknown> | undefined;
    if(existing?.id) { seeded.set(table,String(existing.id)); return String(existing.id); }
    const columns=db.prepare(`pragma table_info(${table})`).all() as Array<{name:string;type:string;notnull:number;dflt_value:unknown;pk:number}>;
    const foreign=db.prepare(`pragma foreign_key_list(${table})`).all() as Array<{from:string;table:string;to:string}>;
    const values:Record<string,unknown>={id:`${table}-id`,...overrides[table]};
    seeded.set(table,String(values.id));
    for(const column of columns) {
      if(column.name in values) continue;
      const relation=foreign.find(key=>key.from===column.name);
      if(relation && column.notnull) values[column.name]=seed(relation.table);
      else if(column.notnull && column.dflt_value===null) values[column.name]=/int|real/i.test(column.type)?1:column.name.endsWith('_json')?'{}':'preserved source value';
    }
    if(!columns.some(column=>column.name==='id')) delete values.id;
    const names=Object.keys(values);
    db.prepare(`insert into ${table}(${names.join(',')}) values(${names.map(()=>'?').join(',')})`).run(...names.map(name=>values[name]) as never[]);
    return String(values.id);
  }
  const tables=['agent_memories','seo_strategy_versions','seo_research_sources','seo_strategy_documents','seo_topic_territories',
    'topic_decision_results','content_production_groups','seo_keyword_clusters','topic_decision_items','content_artifacts',
    'content_review_interactions','seo_strategy_keywords','seo_keyword_sources'];
  for(const table of tables) seed(table);
  const snapshots = new Map(tables.map(table=>[table,db.prepare(`select * from ${table}`).all()]));
  const compare = () => {
    for(const table of tables) {
      const columns=Object.keys(snapshots.get(table)![0]);
      expect(db.prepare(`select ${columns.join(',')} from ${table}`).all(),table).toEqual(snapshots.get(table));
    }
    expect(db.prepare('pragma foreign_key_check').all()).toEqual([]);
  };
  db.exec(readFileSync(new URL('0052_runtime_artifact_submissions.sql',directory),'utf8'));
  compare();
  db.exec('begin; pragma defer_foreign_keys=on; delete from agent_runs; delete from seo_strategy_runs; commit;');
  compare();
  expect(db.prepare('select source_run_id from agent_memories').get()).toEqual({source_run_id:'run'});
  db.close();
});
