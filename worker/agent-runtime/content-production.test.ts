// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  applyContentReviewDecision,
  persistArticleArtifact,
  type ArticleTask,
  articleVersionsForContentReview,
  contentReviewBody,
  contentGroupStartupContext,
  claimContentProductionGroup,
  inspectContentProductionGroup,
  markContentGroupAttention,
} from './content-production';
import { reconcileCancelledAgentRun } from './run-lifecycle';
import type { AgentRun } from './protocol';
import { assembleContext } from './context';
import { persistRuntimeJson } from './runtime-content';

function fixtureDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    create table content_production_groups (
      id text primary key, workspace_id text not null, site_id text not null,
      status text not null, total_items integer not null, ready_items integer not null,
      failed_items integer not null, review_round integer not null default 0, review_json text not null default '{}',
      error text not null, updated_at text not null
    );
    create table jobs (
      id text primary key, production_group_id text not null, decision_item_id text not null default '',
      child_run_id text not null default '', status text not null,
      current_artifact_id text not null default '', versions_json text not null default '[]',
      qa_report text not null default '{}', error text not null default '', review_note text not null default '',
      content_updated_at text not null default '', updated_at text not null default ''
    );
    create table content_artifacts (
      id text primary key, group_id text not null, job_id text not null, decision_item_id text not null default '', attempt integer not null,
      status text not null, versions_json text not null, qa_report_json text not null,
      parent_review_json text not null default '{}', child_run_id text not null default '', updated_at text not null,
      submission_operation_id text unique, seo_contract_json text default '{}', supersedes_artifact_id text default '', created_at text default ''
    );
    create table content_review_interactions (
      id text primary key, idempotency_key text not null unique, group_id text not null, job_id text not null,
      artifact_id text not null, parent_run_id text not null, child_run_id text not null, kind text not null,
      actor_type text not null, actor_id text not null, summary text not null, payload_json text not null, created_at text not null
    );
    create table agent_tasks(id text primary key,active_run_id text,assignment_id text);
    create table agent_task_assignments(id text primary key,task_id text,context_json text);
    create table agent_runtime_content_chunks(content_id text,chunk_index integer,character_offset integer,characters integer,value text,primary key(content_id,chunk_index));
    create table agent_runs (
      id text primary key, workspace_id text not null, site_id text not null, agent_id text not null,
      agent_instance_id text not null, parent_run_id text not null, status text not null default 'queued',
      phase text not null default '', error text not null default '', output_json text not null default '{}', created_at text not null default ''
    );
    create trigger reviewer_fixture after insert on agent_runs when new.agent_id='content_review' begin
      insert into agent_tasks values(new.id,new.id,new.id);
      insert into agent_task_assignments values(new.id,new.id,json_object('artifact_id',new.agent_instance_id));
      update agent_runs set agent_instance_id=(select j.decision_item_id from content_artifacts a join jobs j on j.id=a.job_id where a.id=new.agent_instance_id) where id=new.id;
    end;
    create table topic_decision_items (
      id text primary key, title_direction text not null, primary_keyword text not null,
      group_role text not null, sort_order integer not null
    );
    insert into content_production_groups values ('group-1', 'workspace-1', 'site-1', 'reviewing', 2, 0, 0, 0, '{}', '', '');
    insert into topic_decision_items values
      ('item-1', 'Useful guide', 'useful guide', 'anchor', 1),
      ('item-2', 'Supporting guide', 'supporting guide', 'support', 2);
    insert into jobs (id, production_group_id, decision_item_id, status) values
      ('job-1', 'group-1', 'item-1', 'drafting'), ('job-2', 'group-1', 'item-2', 'drafting');
    insert into content_artifacts (id, group_id, job_id, attempt, status, versions_json, qa_report_json, updated_at) values
      ('old-1', 'group-1', 'job-1', 1, 'candidate', '[{"locale":"en","slug":"old"}]', '{"ok":true}', ''),
      ('new-1', 'group-1', 'job-1', 2, 'candidate', '[{"locale":"en","slug":"new"}]', '{"ok":true}', ''),
      ('only-2', 'group-1', 'job-2', 1, 'candidate', '[{"locale":"en","slug":"two"}]', '{"ok":true}', '');
    insert into agent_runs (
      id, workspace_id, site_id, agent_id, agent_instance_id, parent_run_id, status, phase, created_at
    ) values ('parent-1', 'workspace-1', 'site-1', 'content_production', '', '', 'running', 'managing_content_group', '2026-08-29T00:00:00Z');
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
        } catch (error) { sqlite.exec('rollback'); throw error; }
      },
    } as unknown as D1Database,
  };
}

describe('content production persistence', () => {
  it('lets a new content Run claim a group only after its prior owner ends', async () => {
    const fixture = fixtureDb();
    fixture.sqlite.exec("alter table content_production_groups add column parent_run_id text not null default 'parent-1'");
    await expect(claimContentProductionGroup(fixture.db, 'workspace-1', 'site-1', 'group-1', 'next-run'))
      .rejects.toThrow('owned by an active Run');
    fixture.sqlite.prepare("update agent_runs set status='succeeded' where id='parent-1'").run();
    await claimContentProductionGroup(fixture.db, 'workspace-1', 'site-1', 'group-1', 'next-run');
    await claimContentProductionGroup(fixture.db, 'workspace-1', 'site-1', 'group-1', 'next-run');
    expect(fixture.sqlite.prepare("select parent_run_id from content_production_groups where id='group-1'").get())
      .toEqual({ parent_run_id: 'next-run' });
    fixture.sqlite.prepare("insert into agent_runs(id,workspace_id,site_id,agent_id,agent_instance_id,parent_run_id,status) values('next-run','workspace-1','site-1','content_production','','','running')").run();
    await expect(claimContentProductionGroup(fixture.db, 'workspace-1', 'site-1', 'group-1', 'racing-run'))
      .rejects.toThrow('owned by an active Run');
  });
  it('claims a newly approved group whose original Run has not started', async () => {
    const fixture = fixtureDb();
    fixture.sqlite.exec("alter table content_production_groups add column parent_run_id text not null default 'reserved-run'");
    await claimContentProductionGroup(fixture.db, 'workspace-1', 'site-1', 'group-1', 'leader-child');
    expect(fixture.sqlite.prepare("select parent_run_id from content_production_groups where id='group-1'").get())
      .toEqual({ parent_run_id: 'leader-child' });
  });
  it('commits an isolated review only to the exact latest artifact owned by its Run', async () => {
    const fixture = fixtureDb();
    fixture.sqlite.exec(`
      insert into agent_runs (id, workspace_id, site_id, agent_id, agent_instance_id, parent_run_id) values
        ('review-stale', 'workspace-1', 'site-1', 'content_review', 'old-1', 'parent-1'),
        ('review-current', 'workspace-1', 'site-1', 'content_review', 'new-1', 'parent-1');
    `);
    const pass = {
      decision: 'pass' as const,
      value_assessment: 'The article resolves the approved intent.',
      seo_geo_risks: [],
      required_changes: [],
      judgment_summary: 'Ready for human review.',
    };
    await expect(applyContentReviewDecision(fixture.db, 'review-stale', {
      group_id: 'group-1', job_id: 'job-1', artifact_id: 'old-1',
    }, pass)).rejects.toThrow('changed after this Run started');
    await expect(applyContentReviewDecision(fixture.db, 'review-current', {
      group_id: 'group-1', job_id: 'job-1', artifact_id: 'new-1',
    }, pass)).resolves.toEqual({ artifactId: 'new-1', jobId: 'job-1', decision: 'pass' });
    expect(fixture.sqlite.prepare('select id, status from content_artifacts where job_id = ? order by attempt').all('job-1')).toEqual([
      { id: 'old-1', status: 'candidate' },
      { id: 'new-1', status: 'accepted' },
    ]);
    expect(fixture.sqlite.prepare('select status, current_artifact_id from jobs where id = ?').get('job-1')).toEqual({
      status: 'awaiting_review', current_artifact_id: 'new-1',
    });
  });

  it('revises in the same author and reviewer Runs, preserving both candidates and operation receipts', async () => {
    const f=fixtureDb();
    const task={group_id:'group-1',job_id:'job-1',decision_item_id:'item-1',attempt:3,previous_artifact_id:'new-1',locales:['en'],hub_path:'/guide',hub_urls:[],product_origin:'',blog_origin:'',published_articles:[],group_articles:[]} as unknown as ArticleTask;
    const bundle={versions:[{locale:'en',slug:'durable-work',title:'Durable work',excerpt:'A guide.',content:'## Durable execution\n\nSee the [documentation guide](/guide) for the saved execution contract.'}],seo_contract:{}} as never;
    const env={DB:f.db} as never;
    const first=await persistArticleArtifact(env,'one-author',task,bundle,'submit-1');
    f.sqlite.prepare("insert into agent_runs(id,workspace_id,site_id,agent_id,agent_instance_id,parent_run_id) values('one-reviewer','workspace-1','site-1','content_review',?,'parent-1')").run(first.artifactId);
    const review={decision:'revise' as const,value_assessment:'Clarify the boundary',seo_geo_risks:[],required_changes:['Explain replay'],judgment_summary:'One gap remains'};
    await applyContentReviewDecision(f.db,'one-reviewer',{...task,artifact_id:first.artifactId},review);
    const revised={...task,attempt:4,previous_artifact_id:first.artifactId};
    const second=await persistArticleArtifact(env,'one-author',revised,bundle,'submit-2');
    const assigned = await persistRuntimeJson(f.db, {artifact_id:second.artifactId, candidate_material:'Full candidate paragraph.\n'.repeat(10000)});
    expect(assigned).toContain('$runtime_content');
    f.sqlite.prepare("update agent_task_assignments set context_json=? where id='one-reviewer'").run(assigned);
    await expect(applyContentReviewDecision(f.db,'one-reviewer',{...task,artifact_id:first.artifactId},review)).rejects.toThrow('does not own');
    await applyContentReviewDecision(f.db,'one-reviewer',{...task,artifact_id:second.artifactId},{...review,decision:'pass',required_changes:[]});
    expect(await persistArticleArtifact(env,'one-author',task,bundle,'submit-1')).toMatchObject({artifactId:first.artifactId});
    expect(await persistArticleArtifact(env,'one-author',revised,bundle,'submit-2')).toMatchObject({artifactId:second.artifactId});
    expect(f.sqlite.prepare("select child_run_id,status from content_artifacts where child_run_id='one-author' order by attempt").all()).toEqual([{child_run_id:'one-author',status:'rejected'},{child_run_id:'one-author',status:'accepted'}]);
    expect(f.sqlite.prepare("select count(*) as n from content_review_interactions where actor_id='content_review'").get()).toEqual({n:2});
  });

  it('returns one rejected article to its author without rolling back an accepted sibling', async () => {
    const fixture = fixtureDb();
    fixture.sqlite.exec(`
      insert into agent_runs (id, workspace_id, site_id, agent_id, agent_instance_id, parent_run_id) values
        ('review-one', 'workspace-1', 'site-1', 'content_review', 'new-1', 'parent-1'),
        ('review-two', 'workspace-1', 'site-1', 'content_review', 'only-2', 'parent-1');
    `);
    await applyContentReviewDecision(fixture.db, 'review-one', {
      group_id: 'group-1', job_id: 'job-1', artifact_id: 'new-1',
    }, {
      decision: 'pass', value_assessment: 'Ready.', seo_geo_risks: [], required_changes: [], judgment_summary: 'Pass.',
    });
    await applyContentReviewDecision(fixture.db, 'review-two', {
      group_id: 'group-1', job_id: 'job-2', artifact_id: 'only-2',
    }, {
      decision: 'revise', value_assessment: 'Off intent.', seo_geo_risks: ['intent mismatch'],
      required_changes: ['Refocus the opening on the approved intent.'], judgment_summary: 'Revise.',
    });
    expect(fixture.sqlite.prepare('select id, status, current_artifact_id, review_note from jobs order by id').all()).toEqual([
      { id: 'job-1', status: 'awaiting_review', current_artifact_id: 'new-1', review_note: '' },
      { id: 'job-2', status: 'drafting', current_artifact_id: '', review_note: 'Refocus the opening on the approved intent.' },
    ]);
    expect(fixture.sqlite.prepare('select status, ready_items from content_production_groups').get()).toEqual({ status: 'reviewing', ready_items: 1 });
  });

  it('preserves a late review result without reviving an already-ended parent Run', async () => {
    const fixture = fixtureDb();
    fixture.sqlite.exec(`
      update agent_runs set status = 'failed', phase = 'failed' where id = 'parent-1';
      insert into agent_runs (id, workspace_id, site_id, agent_id, agent_instance_id, parent_run_id) values
        ('review-late', 'workspace-1', 'site-1', 'content_review', 'only-2', 'parent-1');
    `);
    await applyContentReviewDecision(fixture.db, 'review-late', {
      group_id: 'group-1', job_id: 'job-2', artifact_id: 'only-2',
    }, {
      decision: 'pass', value_assessment: 'Ready.', seo_geo_risks: [], required_changes: [], judgment_summary: 'Pass.',
    });
    expect(fixture.sqlite.prepare('select status, ready_items, error from content_production_groups').get()).toEqual({
      status: 'needs_attention', ready_items: 1, error: 'This article\'s review result has been saved; the parent Agent needs to continue handling the remaining articles.',
    });
    expect(fixture.sqlite.prepare('select status, current_artifact_id from jobs where id = ?').get('job-2')).toEqual({
      status: 'awaiting_review', current_artifact_id: 'only-2',
    });
  });

  it('exposes each latest isolated review Run in the parent inspection without article bodies', async () => {
    const fixture = fixtureDb();
    fixture.sqlite.exec(`
      insert into agent_runs (
        id, workspace_id, site_id, agent_id, agent_instance_id, parent_run_id, status, phase, created_at
      ) values ('review-current', 'workspace-1', 'site-1', 'content_review', 'new-1', 'parent-1', 'running', 'reviewing_article', '2026-08-29T00:00:00Z');
    `);
    const inspection = await inspectContentProductionGroup(fixture.db, 'workspace-1', 'site-1', 'group-1');
    expect(inspection.items.find((item) => item.job_id === 'job-1')).toMatchObject({
      artifact_id: 'new-1', review_run_id: 'review-current', review_run_status: 'running', review_run_phase: 'reviewing_article',
    });
    expect(JSON.stringify(inspection)).not.toContain('versions_json');
  });

  it('keeps completed artifacts when the group needs local retry', async () => {
    const fixture = fixtureDb();
    await markContentGroupAttention(fixture.db, 'group-1', 'one child failed');
    expect(fixture.sqlite.prepare('select count(*) as n from content_artifacts').get()).toEqual({ n: 3 });
    expect(fixture.sqlite.prepare('select status, ready_items, failed_items, error from content_production_groups').get()).toEqual({
      status: 'needs_attention', ready_items: 0, failed_items: 0, error: 'one child failed',
    });
  });

  it('exposes persisted work timestamps independently of group management ownership', async () => {
    const fixture = fixtureDb();
    fixture.sqlite.exec(`
      alter table jobs add column created_at text default '';
      alter table jobs add column published_at text default '';
      update jobs set created_at = '2026-09-17T07:00:00Z', published_at = '2026-09-17T09:00:00Z', status = 'published' where id = 'job-1';
      update content_artifacts set created_at = '2026-09-17T08:00:00Z' where id = 'new-1';
    `);
    const current = await inspectContentProductionGroup(fixture.db, 'workspace-1', 'site-1', 'group-1', true);
    expect(current.items[0]).toMatchObject({
      job_created_at: '2026-09-17T07:00:00Z', published_at: '2026-09-17T09:00:00Z',
      artifact_created_at: '2026-09-17T08:00:00Z', job_status: 'published',
    });
    const legacy = await inspectContentProductionGroup(fixture.db, 'workspace-1', 'site-1', 'group-1');
    expect(legacy.items[0]).not.toHaveProperty('job_created_at');
  });

  it('returns a cancelled content parent group to a locally retryable state', async () => {
    const fixture = fixtureDb();
    await reconcileCancelledAgentRun(fixture.db, {
      id: 'run-1', agent_id: 'content_production', summary_json: '{"group_id":"group-1"}',
    } as AgentRun, 'Stopped from the content page');
    expect(fixture.sqlite.prepare('select status, ready_items, error from content_production_groups').get()).toEqual({
      status: 'needs_attention', ready_items: 0, error: 'Stopped from the content page',
    });
  });
});

describe('content production startup context', () => {
  it('does not classify existing work as current when this run has claimed the group', () => {
    const context = contentGroupStartupContext({
      id: 'group-1', workspace_id: 'workspace-1', site_id: 'site-1', decision_group_id: 'decision-1',
      parent_run_id: 'new-run', status: 'awaiting_review', total_items: 1, ready_items: 1, failed_items: 0,
      review_round: 2, review_json: '{}', error: '', created_at: '2026-09-17', updated_at: '2026-09-24',
    }, {}, [{ job_id: 'job-1', published_at: '2026-09-17' }], 'new-run', '2026-09-24');
    expect(context).not.toHaveProperty('prior_execution');
    expect(context.group_record).toMatchObject({ management_run_id: 'new-run', updated_at: '2026-09-24' });
    expect(context.current_run).toEqual({ id: 'new-run', started_at: '2026-09-24' });
    expect(context.items).toEqual([{ job_id: 'job-1', published_at: '2026-09-17' }]);
  });
  it('preserves a full long article without inserting serialization boundaries for one isolated review context', async () => {
    const body = Array.from({ length: 12_000 }, (_, index) => String(index % 10)).join('');
    const versions = articleVersionsForContentReview([{
      locale: 'en', slug: 'long-article', title: 'Long article', excerpt: 'Complete text', content: body,
    }]);
    expect(versions[0].content).toBe(body);
    expect(versions[0]).not.toHaveProperty('content_chunks');
    const context = await assembleContext([{
      sourceId: 'content_review_task', version: 'artifact-1:1', capturedAt: '', priority: 100,
      value: { versions },
    }], 30_000);
    const retained = context.values.content_review_task as { versions: typeof versions };
    expect(retained.versions[0].content).toBe(body);
  });

  it('preserves punctuation, whitespace and quoted passages across the former chunk boundary', () => {
    const body = ' '.repeat(2) + 'a'.repeat(3783) + '\n> **Locations & Assets:**  \nUse "current", not a guessed path.\n\n';
    const version = { locale: 'en', slug: 'handoff', title: 'Handoff', excerpt: '', content: body };
    const [projected] = articleVersionsForContentReview([version]);
    const transported = JSON.parse(JSON.stringify(projected));
    expect(contentReviewBody(transported)).toBe(body);
    expect(transported.content).toContain('> **Locations & Assets:**  \n');
    expect(transported).not.toHaveProperty('content_chunks');
    const { content, ...metadata } = version;
    expect(contentReviewBody({ ...metadata, content_chunks: [content.slice(0, 3800), content.slice(3800)] })).toBe(body);
  });

  it('keeps a prior parent failure as historical evidence instead of current group state', () => {
    const context = contentGroupStartupContext({
      id: 'group-1', workspace_id: 'workspace-1', site_id: 'site-1', decision_group_id: 'decision-1',
      parent_run_id: 'old-run', status: 'needs_attention', total_items: 1, ready_items: 0, failed_items: 0,
      review_round: 0, review_json: '{}', error: 'OpenRouter 404', created_at: '', updated_at: '2026-08-29T00:00:00.000Z',
    }, { model: 'legacy-site-model', name: 'Example site', source_locale: 'en' }, [{ job_id: 'job-1' }], 'new-run');
    expect(context.group).toEqual(expect.objectContaining({ id: 'group-1', total_items: 1 }));
    expect(context).not.toHaveProperty('group.error');
    expect(context.prior_execution).toEqual(expect.objectContaining({
      parent_run_id: 'old-run', error: 'OpenRouter 404', historical: true,
    }));
    expect(context.site).not.toHaveProperty('model');
  });
});

it('assigns separate execution instances to independent editorial groups', async () => {
  const { contentGroupInstance } = await import('./content-production');
  expect(contentGroupInstance('g-en')).not.toBe(contentGroupInstance('g-pt'));
  expect(contentGroupInstance('g--en')).not.toContain('--');
  expect(() => contentGroupInstance('')).toThrow('saved group');
});
