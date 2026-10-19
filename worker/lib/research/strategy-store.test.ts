// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { finalizeRuntimeStrategyBundle, persistStrategyBundle } from './strategy-store';

function strategyDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    create table seo_strategy_versions (
      id text primary key, site_id text not null, run_id text not null, version integer not null, locale_version integer not null,
      status text not null, change_summary text not null, business_snapshot_json text not null,
      research_scope_json text not null, source_locale text not null, created_at text not null,
      unique(site_id, version), unique(site_id, source_locale, locale_version)
    );
    create unique index one_active on seo_strategy_versions(site_id, source_locale) where status = 'active';
    create table seo_strategy_documents (
      id text primary key, strategy_version_id text not null, doc_type text not null,
      body_md text not null, content_hash text not null, created_at text not null,
      unique(strategy_version_id, doc_type)
    );
    create table seo_research_sources (id text primary key, strategy_version_id text, source_type text, url text, title text, query text, locale text, market text, status text, observation_md text, metadata_json text, observed_at text);
    create table seo_topic_territories (id text primary key, strategy_version_id text, territory_key text, name text, priority_band text, status text, audience_summary text, search_job_summary text, business_goal text, conversion_goal text, summary text, sort_order integer);
    create table seo_keyword_clusters (id text primary key, strategy_version_id text, territory_id text, cluster_key text, name text, priority_band text, status text, strategic_role text, recommended_hub text, conversion_goal text, summary text, sort_order integer);
    create table seo_keywords (id text primary key, site_id text, term text, normalized_term text, locale text, market text, lifecycle_status text, first_seen_at text, last_seen_at text, unique(site_id, normalized_term, locale, market));
    create table seo_strategy_keywords (id text primary key, strategy_version_id text, keyword_id text, cluster_id text, intent text, journey_stage text, serp_shape text, recommended_page_type text, business_relevance text, conversion_route text, priority_band text, priority_rationale text, coverage_status text, decision text, existing_url text, evidence_summary text, created_at text);
    create table seo_keyword_sources (strategy_keyword_id text, source_id text, evidence_type text, note text, primary key(strategy_keyword_id, source_id));
    create table agent_runs (
      id text primary key, status text not null, phase text not null, error_code text not null default '',
      error text not null default '', output_json text not null default '{}', summary_json text not null default '{}',
      finished_at text not null default '', updated_at text not null default ''
    );
    create table seo_strategy_runs (
      id text primary key, status text not null, phase text not null, error text not null default '',
      summary_json text not null default '{}', finished_at text not null default ''
    );
    insert into seo_strategy_versions values ('v1', 'site-1', 'run-old', 1, 1, 'active', 'old', '{}', '{}', 'en', '2026-08-23T00:00:00.000Z');
  `);
  // @ts-ignore Node test URL.
  sqlite.exec(readFileSync(new URL('../../../migrations/0039_agent_tasks.sql', import.meta.url), 'utf8'));
  // @ts-ignore Node test URL.
  sqlite.exec(readFileSync(new URL('../../../migrations/0055_strategy_report_snapshots.sql', import.meta.url), 'utf8'));
  sqlite.exec("alter table seo_strategy_versions add column submission_operation_id text not null default 'legacy:v1'; create unique index submissions on seo_strategy_versions(submission_operation_id);");
  let failKeywordMap = true;
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind: (...next: unknown[]) => {
        values = next;
        return {
          first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
          all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
          run: async () => {
            if (failKeywordMap && sql.includes('insert into seo_strategy_documents') && values[2] === 'keyword_map') {
              throw new Error('injected document failure');
            }
            return { meta: { changes: sqlite.prepare(sql).run(...values as never[]).changes } };
          },
        };
      },
      run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values as never[]).changes } }),
    };
    return statement;
  };
  return {
    db: {
      prepare,
      batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
        sqlite.exec('begin');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.exec('commit');
          return results;
        } catch (error) {
          sqlite.exec('rollback');
          throw error;
        }
      },
    } as unknown as D1Database,
    sqlite,
    allowAllDocuments: () => { failKeywordMap = false; },
  };
}

const result = {
  change_summary: 'new', research_scope_summary: 'scope', seo_strategy_md: '# Strategy', research_notes_md: '# Notes',
  territories: [], clusters: [], keywords: [],
};

describe('strategy bundle activation', () => {
  it('keeps the old version active on partial failure, then activates exactly one idempotent bundle', async () => {
    const fixture = strategyDb();
    const input = {
      db: fixture.db, siteId: 'site-1', runId: 'run-new', sourceLocale: 'en', businessSnapshot: {},
      result, citations: [],
    };
    await expect(persistStrategyBundle(input)).rejects.toThrow('injected document failure');
    expect(fixture.sqlite.prepare("select id from seo_strategy_versions where status = 'active'").all()).toEqual([{ id: 'v1' }]);

    fixture.allowAllDocuments();
    const version = await persistStrategyBundle(input);
    expect(version).toMatchObject({ run_id: 'run-new', version: 2, status: 'active' });
    expect(fixture.sqlite.prepare("select run_id, status from seo_strategy_versions order by version").all()).toEqual([
      { run_id: 'run-old', status: 'superseded' }, { run_id: 'run-new', status: 'active' },
    ]);
    expect(fixture.sqlite.prepare('select count(*) as count from seo_strategy_documents where strategy_version_id = ?').get(version.id)).toEqual({ count: 3 });

    await expect(persistStrategyBundle(input)).resolves.toMatchObject({ id: version.id, status: 'active' });
    expect(fixture.sqlite.prepare('select count(*) as count from seo_strategy_versions').get()).toEqual({ count: 2 });
  });

  it('activates a deferred Runtime bundle while leaving the ongoing conversation open', async () => {
    const fixture = strategyDb();
    fixture.allowAllDocuments();
    fixture.sqlite.exec(`
      insert into agent_runs (id, status, phase) values ('run-runtime', 'running', 'persisting_strategy');
      insert into seo_strategy_runs (id, status, phase) values ('run-runtime', 'running', 'persisting_strategy');
    `);
    const version = await persistStrategyBundle({
      db: fixture.db, siteId: 'site-1', runId: 'run-runtime', sourceLocale: 'en',
      businessSnapshot: {}, result, citations: [], activate: false,
    });
    expect(version.status).toBe('draft');
    expect(fixture.sqlite.prepare("select id from seo_strategy_versions where status = 'active'").all()).toEqual([{ id: 'v1' }]);

    await expect(finalizeRuntimeStrategyBundle({
      db: fixture.db, siteId: 'site-1', runId: 'run-runtime', versionId: version.id,
      summary: { strategy_version: version.version },
    })).resolves.toMatchObject({ id: version.id, status: 'active' });
    expect(fixture.sqlite.prepare('select status, phase from agent_runs where id = ?').get('run-runtime')).toEqual({ status: 'running', phase: 'persisting_strategy' });
    expect(fixture.sqlite.prepare('select status, phase from seo_strategy_runs where id = ?').get('run-runtime')).toEqual({ status: 'running', phase: 'strategy_submitted' });
  });

  it('submits two versions from the same Run and deduplicates each operation independently', async () => {
    const fixture=strategyDb();fixture.allowAllDocuments();
    const input={db:fixture.db,siteId:'site-1',runId:'one-run',sourceLocale:'en',businessSnapshot:{},result,citations:[]};
    const first=await persistStrategyBundle({...input,operationId:'submission-1'});
    const second=await persistStrategyBundle({...input,operationId:'submission-2',result:{...result,change_summary:'Revised with new evidence'}});
    expect(first.id).not.toBe(second.id);
    expect(second.version).toBe(first.version+1);
    expect(await persistStrategyBundle({...input,operationId:'submission-1'})).toMatchObject({id:first.id,status:'superseded'});
    expect(await persistStrategyBundle({...input,operationId:'submission-2'})).toMatchObject({id:second.id,status:'active'});
    expect(fixture.sqlite.prepare('select count(*) as n from seo_strategy_versions where run_id=?').get('one-run')).toEqual({n:2});
  });

  it('keeps one independently active strategy for every project locale', async () => {
    const fixture = strategyDb();
    fixture.allowAllDocuments();
    const zh = await persistStrategyBundle({
      db: fixture.db, siteId: 'site-1', runId: 'run-zh', sourceLocale: 'zh-CN',
      businessSnapshot: {}, result, citations: [],
    });
    expect(zh).toMatchObject({ source_locale: 'zh-CN', version: 1, status: 'active' });
    expect(fixture.sqlite.prepare(
      "select source_locale, status from seo_strategy_versions where status = 'active' order by source_locale",
    ).all()).toEqual([
      { source_locale: 'en', status: 'active' },
      { source_locale: 'zh-CN', status: 'active' },
    ]);
    const en = await persistStrategyBundle({
      db: fixture.db, siteId: 'site-1', runId: 'run-en-next', sourceLocale: 'en',
      businessSnapshot: {}, result, citations: [],
    });
    expect(en).toMatchObject({ source_locale: 'en', version: 2, status: 'active' });
  });

  it('does not activate a deferred bundle after its Runtime Run has failed', async () => {
    const fixture = strategyDb();
    fixture.allowAllDocuments();
    fixture.sqlite.exec(`
      insert into agent_runs (id, status, phase) values ('run-failed', 'running', 'persisting_strategy');
      insert into seo_strategy_runs (id, status, phase) values ('run-failed', 'running', 'persisting_strategy');
    `);
    const version = await persistStrategyBundle({
      db: fixture.db, siteId: 'site-1', runId: 'run-failed', sourceLocale: 'en',
      businessSnapshot: {}, result, citations: [], activate: false,
    });
    fixture.sqlite.prepare("update agent_runs set status = 'failed', phase = 'workflow_failed' where id = 'run-failed'").run();

    await expect(finalizeRuntimeStrategyBundle({
      db: fixture.db, siteId: 'site-1', runId: 'run-failed', versionId: version.id, summary: {},
    })).rejects.toThrow('active Run gate');
    expect(fixture.sqlite.prepare("select id from seo_strategy_versions where status = 'active'").all()).toEqual([{ id: 'v1' }]);
    expect(fixture.sqlite.prepare('select status from seo_strategy_versions where id = ?').get(version.id)).toEqual({ status: 'draft' });
  });
  it('preserves the active strategy when the submitted draft does not exist', async () => {
    const fixture = strategyDb();
    fixture.sqlite.exec("insert into agent_runs (id,status,phase) values ('run-invalid','running','submit'); insert into seo_strategy_runs(id,status,phase) values ('run-invalid','running','submit');");
    await expect(finalizeRuntimeStrategyBundle({ db: fixture.db, siteId: 'site-1', runId: 'run-invalid', versionId: 'missing', sourceLocale: 'en', summary: {} })).rejects.toThrow();
    expect(fixture.sqlite.prepare("select id from seo_strategy_versions where status = 'active'").all()).toEqual([{ id: 'v1' }]);
  });

  it.each(['running', 'cancelled'])('gates strategy activation and task completion atomically when task is %s', async (status) => {
    const fixture = strategyDb(); fixture.allowAllDocuments();
    fixture.sqlite.exec("insert into agent_runs(id,status,phase) values('run-task','running','submit'); insert into seo_strategy_runs(id,status,phase) values('run-task','running','submit');");
    fixture.sqlite.prepare(`insert into agent_tasks(id,workspace_id,site_id,agent_id,agent_instance_id,definition_version,status,active_run_id,revision,goal_json,max_turns,max_model_calls,max_tokens,created_at,updated_at)
      values('task','w','site-1','strategy_research','strategy:en',20,?,'run-task',3,'{}',30,70,3000000,'now','now')`).run(status);
    fixture.sqlite.exec("insert into agent_task_operations(id,task_id,turn,status,context_json,created_at,updated_at) values('task:1','task',1,'ready','{}','now','now');");
    const version = await persistStrategyBundle({ db: fixture.db, siteId: 'site-1', runId: 'run-task', sourceLocale: 'en', businessSnapshot: {}, result, citations: [], activate: false });
    const input = { db: fixture.db, siteId: 'site-1', runId: 'run-task', versionId: version.id, sourceLocale: 'en', summary: { outcome: 'completed' }, expectedBaseVersionId: 'v1', task: { id: 'task', epoch: 1, revision: 3, operationId: 'task:1' } };
    if (status === 'cancelled') {
      await expect(finalizeRuntimeStrategyBundle(input)).rejects.toThrow();
      expect(fixture.sqlite.prepare("select id from seo_strategy_versions where status='active'").all()).toEqual([{ id: 'v1' }]);
      expect(fixture.sqlite.prepare("select status from agent_task_operations where id='task:1'").get()).toEqual({ status: 'ready' });
    } else {
      await expect(finalizeRuntimeStrategyBundle({ ...input, task: { ...input.task, revision: 2 } })).rejects.toThrow();
      expect(fixture.sqlite.prepare("select id from seo_strategy_versions where status='active'").all()).toEqual([{ id: 'v1' }]);
      await finalizeRuntimeStrategyBundle(input);
      expect(fixture.sqlite.prepare("select status,next_turn from agent_tasks where id='task'").get()).toEqual({ status: 'running', next_turn: 1 });
      expect(fixture.sqlite.prepare("select status from agent_task_operations where id='task:1'").get()).toEqual({ status: 'succeeded' });
    }
  });

  it.each([
    { expected: 'v1', active: true, succeeds: true },
    { expected: 'stale', active: true, succeeds: false },
    { expected: '', active: true, succeeds: false },
    { expected: 'v1', active: false, succeeds: false },
    { expected: '', active: false, succeeds: true },
  ])('atomically compares the active strategy with $expected (active=$active)', async ({ expected, active, succeeds }) => {
    const fixture = strategyDb(); fixture.allowAllDocuments();
    fixture.sqlite.exec("insert into agent_runs(id,status,phase) values('run-new','running','submit'); insert into seo_strategy_runs(id,status,phase) values('run-new','running','submit');");
    if (!active) fixture.sqlite.exec("update seo_strategy_versions set status='superseded' where id='v1'");
    const version = await persistStrategyBundle({ db: fixture.db, siteId: 'site-1', runId: 'run-new', sourceLocale: 'en', businessSnapshot: {}, result, citations: [], activate: false });
    const input = { db: fixture.db, siteId: 'site-1', runId: 'run-new', versionId: version.id, sourceLocale: 'en', summary: {}, expectedBaseVersionId: expected };
    if (succeeds) {
      expect(await finalizeRuntimeStrategyBundle(input)).toMatchObject({ id: version.id, status: 'active' });
    } else {
      await expect(finalizeRuntimeStrategyBundle(input)).rejects.toMatchObject({ details: { kind: 'state_conflict', effects: 'preserved' } });
      expect(fixture.sqlite.prepare("select id from seo_strategy_versions where status='active'").all()).toEqual(active ? [{ id: 'v1' }] : []);
      expect(fixture.sqlite.prepare('select status from seo_strategy_versions where id=?').get(version.id)).toEqual({ status: 'draft' });
      expect(fixture.sqlite.prepare("select status from agent_runs where id='run-new'").get()).toEqual({ status: 'running' });
      // The Agent may explicitly reconcile against the observed version and reuse the saved draft.
      expect(await finalizeRuntimeStrategyBundle({ ...input, expectedBaseVersionId: active ? 'v1' : '' })).toMatchObject({ status: 'active' });
    }
    expect(fixture.sqlite.prepare('select id from seo_strategy_documents where strategy_version_id=?').all(version.id)).toHaveLength(3);
  });

});
