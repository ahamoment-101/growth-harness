// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { taskTestDb } from '../../agent-runtime/task-test-db';
import { attachTask } from '../../agent-runtime/task-store';
import { agentDefinition } from '../../agent-runtime/definitions';
import { executionDatabase } from '../../agent-runtime/execution-context';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution } from '../../agent-runtime/runtime-executions';
import { restoreStrategyReports, strategyReportDelivery, strategyReportTypes } from './report-delivery';

function fixture() {
  const f = taskTestDb();
  f.sqlite.exec(`create table seo_strategy_versions(id text primary key,site_id text,source_locale text,status text,locale_version integer,run_id text default '');
    create table seo_strategy_documents(id text primary key,strategy_version_id text,doc_type text,body_md text,content_hash text,created_at text,unique(strategy_version_id,doc_type));
    insert into seo_strategy_versions(id,site_id,source_locale,status,locale_version) values('v1','s','en','active',1),('pt','s','pt-BR','active',1),('other','other-site','en','active',1);`);
  for (const type of strategyReportTypes) f.sqlite.prepare('insert into seo_strategy_documents values(?,?,?,?,?,?)')
    .run(type, 'v1', type, `original ${type} not verified`, `hash-${type}`, '2026-09-10');
  // @ts-ignore Test-only Node URL.
  f.sqlite.exec(readFileSync(new URL('../../../migrations/0055_strategy_report_snapshots.sql', import.meta.url), 'utf8'));
  return f;
}

it('backfills exact reports, restores only missing rows and replays without changing existing prose or strategy', async () => {
  const f = fixture();
  f.sqlite.exec("delete from seo_strategy_documents where doc_type='strategy'; update seo_strategy_documents set body_md='kept' where doc_type='keyword_map';");
  expect(await strategyReportDelivery(f.db, 's', 'en', 'v1')).toMatchObject({ complete: false, missing: ['strategy'] });
  const first = await restoreStrategyReports(f.db, 's', 'en', 'v1');
  const rows = f.sqlite.prepare('select * from seo_strategy_documents order by doc_type').all();
  expect(first).toMatchObject({ strategy_changed: false, delivery: { complete: true, version_id: 'v1' } });
  expect(rows).toContainEqual(expect.objectContaining({ doc_type: 'strategy', body_md: 'original strategy not verified', content_hash: 'hash-strategy', created_at: '2026-09-10' }));
  expect(rows).toContainEqual(expect.objectContaining({ doc_type: 'keyword_map', body_md: 'kept' }));
  expect(await restoreStrategyReports(f.db, 's', 'en', 'v1')).toEqual(first);
  expect(f.sqlite.prepare('select * from seo_strategy_documents order by doc_type').all()).toEqual(rows);
  expect(f.sqlite.prepare('select count(*) as n from seo_strategy_versions').get()).toEqual({ n: 3 });
});

it('preserves partial delivery and reports absent history instead of inventing original reports', async () => {
  const f = fixture();
  f.sqlite.exec("delete from seo_strategy_documents; delete from seo_strategy_report_snapshots where doc_type='research_notes';");
  expect(await restoreStrategyReports(f.db, 's', 'en', 'v1')).toMatchObject({ delivery: { complete: false, missing: ['research_notes'], present: ['strategy', 'keyword_map'] }, limitations: expect.stringContaining('no recoverable snapshot') });
});

it('rejects another site, locale, draft or missing version without writes', async () => {
  const f = fixture();
  f.sqlite.exec("delete from seo_strategy_documents; update seo_strategy_versions set status='draft' where id='pt';");
  for (const [site, locale, version] of [['other-site', 'en', 'v1'], ['s', 'pt-BR', 'v1'], ['s', 'pt-BR', 'pt'], ['s', 'en', 'missing']]) {
    await expect(restoreStrategyReports(f.db, site, locale, version)).rejects.toThrow('authorized');
  }
  expect(f.sqlite.prepare('select count(*) as n from seo_strategy_documents').get()).toEqual({ n: 0 });
});

it('rolls back all restoration writes on a partial database failure', async () => {
  const f = fixture();
  f.sqlite.exec(`delete from seo_strategy_documents;
    create trigger fail_report before insert on seo_strategy_documents when new.doc_type='research_notes'
    begin select raise(abort,'injected failure'); end;`);
  await expect(restoreStrategyReports(f.db, 's', 'en', 'v1')).rejects.toThrow('injected failure');
  expect(f.sqlite.prepare('select count(*) as n from seo_strategy_documents').get()).toEqual({ n: 0 });
});

it('uses the existing execution fence and cannot restore after task cancellation', async () => {
  const f = fixture();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const execution = await createRuntimeExecution(f.db, task.active_run_id);
  const authority = authorityForExecution(execution);
  await activateRuntimeExecution(f.db, authority, execution.workflow_id);
  const scoped = executionDatabase(f.db, authority);
  f.sqlite.exec("delete from seo_strategy_documents; update agent_tasks set status='cancelled';");
  await expect(restoreStrategyReports(scoped, 's', 'en', 'v1')).rejects.toThrow();
  expect(f.sqlite.prepare('select count(*) as n from seo_strategy_documents').get()).toEqual({ n: 0 });
});

it('does not require a keyword map for versions produced by strategy definitions from v34', async () => {
  const f = fixture();
  const task = await attachTask(f.db, f.run('producer'), agentDefinition('strategy_research'));
  f.sqlite.exec("update seo_strategy_versions set run_id='producer' where id='v1'; delete from seo_strategy_documents where doc_type='keyword_map';");
  expect(await strategyReportDelivery(f.db, 's', 'en', 'v1')).toMatchObject({ complete: true, present: ['strategy', 'research_notes'], missing: [] });
  f.sqlite.prepare('update agent_tasks set definition_version=33 where id=?').run(task.id);
  expect(await strategyReportDelivery(f.db, 's', 'en', 'v1')).toMatchObject({ complete: false, missing: ['keyword_map'] });
});
