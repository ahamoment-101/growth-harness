// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { TopicDecisionOutput } from './topic-decision-contract';
import { approveTopicDecisionResult, persistTopicDecisionResult, rejectTopicDecisionResult, undispatchedTopicResearchRequest } from './topic-decision-store';

function fixtureDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    pragma foreign_keys = on;
    create table sites (id text primary key, workspace_id text not null, source_locale text not null, translate_locales_json text not null default '[]');
    create table seo_strategy_versions (id text primary key, site_id text not null, version integer not null, locale_version integer not null, status text not null, source_locale text not null);
    create table agent_runs (
      id text primary key, workspace_id text not null, site_id text not null, agent_id text not null,
      status text not null, phase text not null, error_code text not null default '', error text not null default '',
      output_json text not null default '{}', summary_json text not null default '{}', finished_at text not null default '',
      updated_at text not null default '', created_at text not null default ''
    );
    create table topics (
      id text primary key, site_id text not null, topic_key text not null, title_hint text not null,
      category text not null, primary_keyword text not null, status text not null, created_at text not null,
      decision_group_id text, decision_item_id text, plan_json text not null default '{}'
    );
    create table jobs (
      id text primary key, site_id text not null, topic_id text, status text not null,
      translation_group text, category text, translate_locales_json text not null default '[]',
      versions_json text not null default '[]', decision_group_id text, decision_item_id text,
      plan_json text not null default '{}', production_group_id text not null default '', source_locale text not null default '', created_at text not null, updated_at text not null
    );
    create table topic_decision_results (
      id text primary key, workspace_id text not null, site_id text not null, run_id text not null, submission_operation_id text not null unique,
      strategy_version_id text, strategy_version integer not null, decision_type text not null,
      status text not null, group_goal text not null default '', rationale text not null default '',
      group_hypothesis text not null default '', expected_signals_json text not null default '[]',
      risks_json text not null default '[]', unknowns_json text not null default '[]',
      previous_group_relationship text not null default '', research_request_json text not null default '{}',
      web_evidence_json text not null default '[]', requested_count integer not null, locales_json text not null default '[]',
      language_decisions_json text not null default '[]', scope_locale text, scope_market text,
      review_operation_id text not null default '', reviewed_by text not null default '', review_note text not null default '', reviewed_at text not null default '',
      created_at text not null, updated_at text not null
    );
    create table content_production_groups (
      id text primary key, workspace_id text not null, site_id text not null, decision_group_id text not null unique,
      parent_run_id text not null, status text not null, total_items integer not null, ready_items integer not null,
      failed_items integer not null, review_round integer not null, review_json text not null, error text not null,
      created_at text not null, updated_at text not null
    );
    create table topic_decision_items (
      id text primary key, result_id text not null references topic_decision_results(id) on delete cascade,
      strategy_keyword_id text not null, keyword_id text not null, topic_key text not null,
      title_direction text not null, primary_keyword text not null, content_type text not null,
      locale text not null, market text not null default '', search_intent text not null, group_role text not null,
      rationale text not null, hypothesis text not null, evidence_json text not null default '[]',
      relationship_to_existing text not null default '', risk text not null default '', sort_order integer not null,
      topic_id text, job_id text, created_at text not null, strategy_version_id text, strategy_version integer not null default 0,
      library_keyword_id text, unique(result_id, sort_order)
    );
    insert into sites values ('site-1', 'workspace-1', 'en', '["zh-CN"]');
    insert into seo_strategy_versions values ('strategy-1', 'site-1', 1, 1, 'active', 'en');
    insert into agent_runs (id, workspace_id, site_id, agent_id, status, phase, summary_json, created_at)
      values ('run-1', 'workspace-1', 'site-1', 'topic_decision', 'running', 'forming_group', '{}', '2026-08-26T00:00:00.000Z'),
        ('run-2', 'workspace-1', 'site-1', 'topic_decision', 'running', 'forming_group', '{}', '2026-08-26T00:00:00.000Z'),
        ('run-3', 'workspace-1', 'site-1', 'topic_decision', 'running', 'forming_group', '{}', '2026-08-26T00:00:00.000Z');
  `);
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind: (...next: unknown[]) => { values = next; return statement; },
      first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
      run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values as never[]).changes } }),
    };
    return statement;
  };
  return {
    sqlite,
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
  };
}

const groupOutput: TopicDecisionOutput = {
  decision_type: 'topic_group', rationale: 'Start with one comparison experiment', research_request: null, defer: null,
  group: {
    goal: 'Validate comparison demand', hypothesis: 'Comparison traffic will be qualified',
    expected_signals: ['impressions'], risks: [], unknowns: [], previous_group_relationship: 'first group',
    items: [{
      strategy_keyword_id: 'sk-1', keyword_id: 'kw-1', topic_key: 'best-notes-app',
      title_direction: 'Best notes apps', primary_keyword: 'best notes app', content_type: 'COMPARISON',
      locale: 'en', search_intent: 'comparison', group_role: 'commercial test',
      rationale: 'priority keyword', hypothesis: 'qualified visits',
      evidence: [{ source_type: 'strategy', ref: 'sk-1', summary: 'active strategy' }],
      relationship_to_existing: 'none', risk: 'competitive',
    }],
  },
};

const SCOPE = { locale: 'en' };

describe('topic decision persistence and handoff', () => {
  it('does not hold a delegated topic task behind its own research request', async () => {
    const fixture = fixtureDb();
    fixture.sqlite.exec(`
      alter table topic_decision_results add column research_run_id text not null default '';
      alter table topic_decision_results add column research_dispatch_error text not null default '';
      create table agent_tasks (id text primary key, active_run_id text not null, parent_task_id text not null);
      insert into topic_decision_results (id,workspace_id,site_id,run_id,submission_operation_id,strategy_version,decision_type,status,requested_count,scope_locale,scope_market,created_at,updated_at)
        values ('delegated-request','workspace-1','site-1','run-1','operation-1',1,'needs_research','research_needed',2,'en','global','2026-08-26','2026-08-26');
      insert into agent_tasks values ('run-1','run-1','leader-task');
    `);
    expect(await undispatchedTopicResearchRequest(fixture.db, 'workspace-1', 'site-1', 'en')).toBeNull();
    fixture.sqlite.exec("update agent_tasks set parent_task_id='' where id='run-1'");
    expect(await undispatchedTopicResearchRequest(fixture.db, 'workspace-1', 'site-1', 'en')).toEqual({ id: 'delegated-request' });
  });

  it('completes an active Run exactly once and atomically creates one content-production group', async () => {
    const fixture = fixtureDb();
    const input = {
      db: fixture.db, workspaceId: 'workspace-1', siteId: 'site-1', runId: 'run-1',
      strategyVersionId: 'strategy-1', strategyVersion: 1, requestedCount: 3, locales: ['en'], scope: SCOPE,
      output: groupOutput, webEvidence: [], searchUsed: false, decisionTurns: 2,
    };
    const persisted = await persistTopicDecisionResult(input);
    await expect(persistTopicDecisionResult(input)).resolves.toEqual(persisted);
    expect(fixture.sqlite.prepare('select status, phase from agent_runs where id = ?').get('run-1')).toEqual({ status: 'running', phase: 'forming_group' });
    expect(fixture.sqlite.prepare('select count(*) as n from topic_decision_results').get()).toEqual({ n: 1 });

    const approved = await approveTopicDecisionResult({
      db: fixture.db, workspaceId: 'workspace-1', siteId: 'site-1', resultId: persisted.id,
      actorId: 'user-1', note: 'approved',
    });
    expect(approved.jobIds).toHaveLength(1);
    expect(fixture.sqlite.prepare('select id, parent_run_id, total_items, status from content_production_groups').get()).toEqual({
      id: approved.productionGroupId, parent_run_id: approved.parentRunId, total_items: 1, status: 'queued',
    });
    expect(fixture.sqlite.prepare('select status, decision_group_id from topics').get()).toEqual({ status: 'used', decision_group_id: persisted.id });
    expect(fixture.sqlite.prepare('select status, source_locale, translate_locales_json, decision_group_id, production_group_id from jobs').get()).toEqual({ status: 'queued', source_locale: 'en', translate_locales_json: '[]', decision_group_id: persisted.id, production_group_id: approved.productionGroupId });
    expect(JSON.parse(String((fixture.sqlite.prepare('select plan_json from jobs').get() as { plan_json: string }).plan_json))).toMatchObject({ strategy_keyword_id: 'sk-1', group_goal: 'Validate comparison demand' });
    await expect(approveTopicDecisionResult({ db: fixture.db, workspaceId: 'workspace-1', siteId: 'site-1', resultId: persisted.id, actorId: 'user-1', note: '' })).rejects.toThrow(/already (?:been )?processed/);
  });

  it('does not persist a result after the Run has been cancelled', async () => {
    const fixture = fixtureDb();
    fixture.sqlite.exec("update agent_runs set status = 'cancelled' where id = 'run-1'");
    const researchOutput: TopicDecisionOutput = {
      decision_type: 'needs_research', rationale: 'missing evidence', group: null,
      defer: null,
      research_request: { gap: 'intent', why_blocking: 'page type', known: [], unknown: ['intent'], requested_evidence: ['SERP'], reconsider_after: 'research' },
    };
    await expect(persistTopicDecisionResult({
      db: fixture.db, workspaceId: 'workspace-1', siteId: 'site-1', runId: 'run-1',
      strategyVersionId: 'strategy-1', strategyVersion: 1, requestedCount: 3, locales: ['en'], scope: SCOPE,
      output: researchOutput, webEvidence: [], searchUsed: false, decisionTurns: 2,
    })).rejects.toThrow(/execution gate/);
    expect(fixture.sqlite.prepare('select count(*) as n from topic_decision_results').get()).toEqual({ n: 0 });
  });

  it('requires a reason when rejecting a draft group', async () => {
    const fixture = fixtureDb();
    const result = await persistTopicDecisionResult({
      db: fixture.db, workspaceId: 'workspace-1', siteId: 'site-1', runId: 'run-1',
      strategyVersionId: 'strategy-1', strategyVersion: 1, requestedCount: 1, locales: ['en'], scope: SCOPE,
      output: groupOutput, webEvidence: [], searchUsed: false, decisionTurns: 2,
    });
    await expect(rejectTopicDecisionResult({ db: fixture.db, workspaceId: 'workspace-1', siteId: 'site-1', resultId: result.id, actorId: 'user-1', note: ' ' })).rejects.toThrow(/reason must be provided/);
  });

  it('lets the Agent observe an unfinished production group instead of blocking the Run', async () => {
    const fixture = fixtureDb();
    fixture.sqlite.exec(`
      insert into content_production_groups values (
        'group-1', 'workspace-1', 'site-1', 'decision-1', '', 'needs_attention',
        6, 0, 6, 0, '{}', 'legacy tasks need retry', '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z'
      );
    `);
    fixture.sqlite.exec('delete from seo_strategy_versions');
    const { runtimeAgentModule } = await import('./agent-modules');
    const { scopedTopicSummary, topicInstance } = await import('./topic-scope');
    const summary = scopedTopicSummary({ locale: 'en' });
    await expect(runtimeAgentModule('topic_decision').validateStart!({ DB: fixture.db } as never, {
      workspaceId: 'workspace-1', siteId: 'site-1', agentId: 'topic_decision', trigger: 'manual', summary, instanceId: topicInstance(summary.scope),
    }, { source_locale: 'en', translate_locales_json: '[]' })).resolves.toBeUndefined();
  });

  it('persists a defer decision as an idempotent Run outcome without fabricating a result row', async () => {
    const fixture = fixtureDb();
    const input = {
      db: fixture.db, workspaceId: 'workspace-1', siteId: 'site-1', runId: 'run-1',
      strategyVersionId: 'strategy-1', strategyVersion: 1, requestedCount: 3, locales: ['en'], scope: SCOPE,
      output: {
        decision_type: 'defer' as const, rationale: 'Finish execution before expanding the plan', group: null, research_request: null,
        defer: {
          reason: 'Current production has unresolved failures', blockers: ['failed child tasks'],
          recommended_action: 'Retry the current content group', resume_when: 'the current group is ready for human review',
        },
      },
      webEvidence: [], searchUsed: false, decisionTurns: 2,
    };
    await expect(persistTopicDecisionResult(input)).resolves.toEqual({ id: '', decision: 'defer', status: 'deferred', item_count: 0 });
    await expect(persistTopicDecisionResult(input)).resolves.toEqual({ id: '', decision: 'defer', status: 'deferred', item_count: 0 });
    expect(fixture.sqlite.prepare('select count(*) as n from topic_decision_results').get()).toEqual({ n: 0 });
    const run = fixture.sqlite.prepare('select status, output_json from agent_runs where id = ?').get('run-1') as { status: string; output_json: string };
    expect(run.status).toBe('running');
    expect(JSON.parse(run.output_json)).toEqual({}); // The Runtime persists the tool receipt, then explicitly closes the task.
  });

  it('hands off the saved language even when project languages change after the decision', async () => {
    const fixture = fixtureDb();
    const persisted = await persistTopicDecisionResult({
      db: fixture.db, workspaceId: 'workspace-1', siteId: 'site-1', runId: 'run-1',
      strategyVersionId: 'strategy-1', strategyVersion: 1, requestedCount: 3, locales: ['en'], scope: SCOPE,
      output: groupOutput, webEvidence: [], searchUsed: false, decisionTurns: 4,
    });
    fixture.sqlite.exec("update sites set translate_locales_json = '[\"fr\"]'");
    await approveTopicDecisionResult({
      db: fixture.db, workspaceId: 'workspace-1', siteId: 'site-1', resultId: persisted.id,
      actorId: 'user-1', note: 'approve group',
    });
    expect(fixture.sqlite.prepare('select source_locale, translate_locales_json from jobs').all()).toEqual([
      { source_locale: 'en', translate_locales_json: '[]' },
    ]);
  });
});

it('keeps approved-topic identities while allowing two drafts for one library keyword', async () => {
  const f = fixtureDb();
  f.sqlite.exec("create table keyword_library_entries(id text primary key); insert into keyword_library_entries values('library-word');");
  const input = { db: f.db, workspaceId: 'workspace-1', siteId: 'site-1', runId: 'run-1', strategyVersionId: 'strategy-1', strategyVersion: 1, requestedCount: 2, locales: ['en'], scope: SCOPE, output: groupOutput, webEvidence: [], searchUsed: false, decisionTurns: 1 };
  const old = await persistTopicDecisionResult(input);
  await rejectTopicDecisionResult({ db: f.db, workspaceId: 'workspace-1', siteId: 'site-1', resultId: old.id, actorId: 'user', note: 'Earlier fixture' });
  const output: TopicDecisionOutput = { ...groupOutput, group: { ...groupOutput.group!, items: ['first-contact', 'reply-tone'].map(topic_key => ({ ...groupOutput.group!.items[0], library_keyword_id: 'library-word', keyword_id: 'library-word', strategy_keyword_id: 'library-word', topic_key })) } };
  await expect(persistTopicDecisionResult({ ...input, operationId: 'second-batch', output })).rejects.toThrow('already submitted');
  expect(f.sqlite.prepare("select count(*) as n from topic_decision_results where run_id='run-1'").get()).toEqual({ n: 1 });
  const saved = await persistTopicDecisionResult({ ...input, runId: 'run-2', operationId: 'two-topics', output });
  const { materializeLibraryTopicDrafts } = await import('../keyword-library/topic-drafts');
  const drafts = await materializeLibraryTopicDrafts(f.db, 'workspace-1', 'site-1', saved.id);
  expect(drafts).toHaveLength(2);
  expect(await materializeLibraryTopicDrafts(f.db, 'workspace-1', 'site-1', saved.id)).toEqual(drafts);
  expect(f.sqlite.prepare('select count(*) as n from jobs').get()).toEqual({ n: 0 });
  const ids = drafts.map(row => (row as {topic_id: string}).topic_id).sort();
  const approved = await approveTopicDecisionResult({ db: f.db, workspaceId: 'workspace-1', siteId: 'site-1', resultId: saved.id, actorId: 'user', note: 'Approve same drafts' });
  expect(approved.jobIds).toHaveLength(2);
  expect(f.sqlite.prepare('select id from topics order by id').all().map(row => (row as {id:string}).id)).toEqual(ids);
  expect(f.sqlite.prepare('pragma foreign_key_check').all()).toEqual([]);
});

it('independently approves several language groups without auto translation and rejects unscoped groups', async () => {
  const f = fixtureDb();
  const input = { db: f.db, workspaceId: 'workspace-1', siteId: 'site-1', runId: 'run-1', strategyVersionId: null, strategyVersion: 0, requestedCount: 2, locales: ['en'], scope: SCOPE, output: groupOutput, webEvidence: [], searchUsed: false, decisionTurns: 1 };
  const ids: string[] = [];
  for (const [index, scope] of [{ locale: 'en' }, { locale: 'en' }, { locale: 'pt-BR' }].entries()) {
    const output = { ...groupOutput, group: { ...groupOutput.group!, items: [{ ...groupOutput.group!.items[0], ...scope, topic_key: `distinct-need-${index}` }] } };
    const saved = await persistTopicDecisionResult({ ...input, runId: `run-${index + 1}`, scope, locales: [scope.locale], output, operationId: `scoped-${index}` });
    ids.push(saved.id);
  }
  expect(f.sqlite.prepare("select count(*) as n from topic_decision_results where status='draft' and scope_locale is not null").get()).toEqual({ n: 3 });
  for (const id of [ids[0], ids[2]]) await approveTopicDecisionResult({ db: f.db, workspaceId: 'workspace-1', siteId: 'site-1', resultId: id, actorId: 'user', note: '' });
  expect(f.sqlite.prepare('select source_locale,translate_locales_json from jobs order by source_locale').all()).toEqual([
    { source_locale: 'en', translate_locales_json: '[]' }, { source_locale: 'pt-BR', translate_locales_json: '[]' },
  ]);
  expect(f.sqlite.prepare("select status from topic_decision_results where id=?").get(ids[1])).toEqual({ status: 'draft' });
  await expect(persistTopicDecisionResult({ ...input, operationId: 'wrong-language', scope: { locale: 'fr' } })).rejects.toThrow('saved language');
  f.sqlite.exec("update topic_decision_results set scope_locale=null, scope_market=null where id='" + ids[1] + "'");
  await expect(approveTopicDecisionResult({ db: f.db, workspaceId: 'workspace-1', siteId: 'site-1', resultId: ids[1], actorId: 'user', note: '' })).rejects.toThrow('scope does not match');
  expect(f.sqlite.prepare('pragma foreign_key_check').all()).toEqual([]);
});

it.each(['approve', 'reject'])('binds %s to the exact observed draft version and records the response operation atomically', async action => {
  const f = fixtureDb();
  const saved = await persistTopicDecisionResult({ db: f.db, workspaceId: 'workspace-1', siteId: 'site-1', runId: 'run-1', strategyVersionId: 'strategy-1', strategyVersion: 1, requestedCount: 1, locales: ['en'], scope: SCOPE, output: groupOutput, webEvidence: [], searchUsed: false, decisionTurns: 1 });
  const review = action === 'approve' ? approveTopicDecisionResult : rejectTopicDecisionResult;
  const common = { db: f.db, workspaceId: 'workspace-1', siteId: 'site-1', resultId: saved.id, actorId: 'u', note: 'Review', operationId: 'response-1' };
  await expect(review({ ...common, expectedUpdatedAt: 'stale' })).rejects.toThrow();
  expect(f.sqlite.prepare('select count(*) as n from jobs').get()).toEqual({ n: 0 });
  expect(f.sqlite.prepare('select count(*) as n from content_production_groups').get()).toEqual({ n: 0 });
  const row = f.sqlite.prepare('select updated_at from topic_decision_results where id=?').get(saved.id) as { updated_at: string };
  await review({ ...common, expectedUpdatedAt: row.updated_at });
  expect(f.sqlite.prepare('select review_operation_id,status from topic_decision_results').get()).toEqual({ review_operation_id: 'response-1', status: action === 'approve' ? 'handed_off' : 'rejected' });
});
