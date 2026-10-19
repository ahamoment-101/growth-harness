// @ts-ignore Node-only test dependency.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { attachTask } from '../agent-runtime/task-store';
import { agentDefinition } from '../agent-runtime/definitions';
import { persistRuntimeJson } from '../agent-runtime/runtime-content';
import { readAgentPanel, readAgentPanelTask } from './panel';
import { markSeen, markAllHistorySeen } from './seen';
import { runtimeTasks } from './sources';

async function fixture() {
  const f = taskTestDb();
  f.sqlite.exec(readFileSync(new URL('../../migrations/0038_agent_working_drafts.sql', import.meta.url).pathname, 'utf8'));
  f.sqlite.exec(`create table seo_strategy_versions(id text primary key,site_id text,run_id text,status text,source_locale text,locale_version integer);
    create table seo_strategy_documents(id text primary key,strategy_version_id text,doc_type text,body_md text,created_at text);
    create table content_production_groups(id text primary key,workspace_id text,site_id text,parent_run_id text);
    create table content_artifacts(id text primary key,group_id text,child_run_id text,versions_json text,attempt integer,status text,updated_at text);`);
  f.sqlite.exec(`create table team_status_receipts(workspace_id text,site_id text,agent_id text,task_id text,completed_at text); create table team_status_revisions(workspace_id text not null,site_id text not null,revision integer not null default 0,primary key(workspace_id,site_id));`);
  const run = f.run();
  const task = await attachTask(f.db, run, agentDefinition('strategy_research'));
  return { ...f, task, scope: { db: f.db as unknown as D1Database, workspaceId: 'w', siteId: 's' } };
}

describe('Classroom panel reads', () => {
  it('uses the same versioned receipt for history unread dots and completion bubbles', async () => {
    const f = await fixture();
    f.sqlite.prepare("update agent_tasks set status='completed',outcome='completed' where id=?").run(f.task.id);
    expect((await readAgentPanel(f.scope, 'strategy_research')).tasks[0]).toMatchObject({ work_state: 'history', unread: true });
    expect((await runtimeTasks(f.scope)).some(item => item.kind === 'just_done')).toBe(true);
    const task = (await readAgentPanel(f.scope, 'strategy_research')).tasks[0];
    await markSeen(f.scope, 'strategy_research', task.id, task.updated_at);
    expect((await readAgentPanel(f.scope, 'strategy_research')).tasks[0].unread).toBe(false);
    expect((await runtimeTasks(f.scope)).some(item => item.kind === 'just_done')).toBe(false);
    f.sqlite.prepare("update agent_tasks set updated_at='2099-01-01T00:00:00Z' where id=?").run(task.id);
    expect((await readAgentPanel(f.scope, 'strategy_research')).tasks[0].unread).toBe(true);
    expect((await runtimeTasks(f.scope)).some(item => item.kind === 'just_done')).toBe(true);
  });
  it('counts unread history across pages and marks every eligible completion read', async () => {
    const f = await fixture();
    let pendingId = '';
    for (let i = 0; i < 35; i++) {
      const run = f.run(`unread-${i}`, `strategy:${i}`);
      await attachTask(f.db, run, agentDefinition('strategy_research'));
      f.sqlite.prepare("update agent_tasks set status='completed', outcome='completed' where id=?").run(run.id);
      if (i === 0) pendingId = run.id;
    }
    f.sqlite.prepare(`insert into agent_work_requests(task_id,request_id,handler_id,version,state,node_json,created_at,updated_at)
      values(?,'request','test','v1','pending','{"title":"Please respond"}','now','now')`).run(pendingId);
    const first = await readAgentPanel(f.scope, 'strategy_research');
    expect(first.unread_history_count).toBe(34);
    expect(first.next_cursor).not.toBeNull();
    await markAllHistorySeen(f.scope, 'strategy_research');
    const after = await readAgentPanel(f.scope, 'strategy_research');
    expect(after.unread_history_count).toBe(0);
    expect(after.tasks.find(task => task.id === pendingId)).toMatchObject({ work_state: 'current', attention_count: 1 });
    expect(after.tasks.filter(task => task.work_state === 'history').every(task => !task.unread)).toBe(true);
    expect((await readAgentPanel(f.scope, 'strategy_research', after.next_cursor!)).tasks.every(task => !task.unread)).toBe(true);
    f.sqlite.prepare("update agent_work_requests set state='resolved' where task_id=?").run(pendingId);
    expect((await readAgentPanel(f.scope, 'strategy_research')).unread_history_count).toBe(1);
    f.sqlite.prepare("update agent_tasks set updated_at='2099-01-01T00:00:00Z' where id=?").run(first.tasks.find(task => task.work_state === 'history')!.id);
    expect((await readAgentPanel(f.scope, 'strategy_research')).unread_history_count).toBe(2);
  });
  it('uses saved task briefs and scoped business records as titles across Agent roles', async () => {
    const f = await fixture();
    f.sqlite.exec(`alter table content_production_groups add column decision_group_id text;
      create table topic_decision_results(id text,workspace_id text,site_id text,group_goal text,status text,scope_locale text,scope_market text,updated_at text,run_id text);
      create table jobs(id text,site_id text,topic_id text,decision_item_id text,en_title text,pt_title text,status text,updated_at text,production_group_id text);
      create table topic_decision_items(id text,title_direction text);
      create table topics(id text,title_hint text);
      insert into topic_decision_results values('decision','w','s','Explain the reader problem','accepted','en','us','now','run-1');
      insert into content_production_groups(id,workspace_id,site_id,decision_group_id) values('group','w','s','decision');
      insert into jobs values('job','s','topic','item','Finished article',null,'draft','now','group');
      insert into topic_decision_items values('item','Planned article angle');
      insert into topics values('topic','Topic hint');`);
    const cases = [
      { agent: 'deep_research', goal: { research_question: 'Compare reader evidence' }, title: 'Topic deep research · Compare reader evidence' },
      { agent: 'keyword_research', goal: { research_question: 'Explore search demand' }, title: 'Keyword research · Explore search demand' },
      { agent: 'topic_decision', goal: { scope: { locale: 'en' } }, title: 'English topic selection' },
      { agent: 'content_production', goal: { group_id: 'group' }, title: 'Content creation · Explain the reader problem' },
      { agent: 'article_production', goal: { job_id: 'job' }, title: 'Write article · Planned article angle' },
      { agent: 'content_review', goal: { job_id: 'job' }, title: 'Review article · Planned article angle' },
    ];
    for (const item of cases) {
      f.sqlite.prepare('update agent_tasks set agent_id=?, goal_json=? where id=?').run(item.agent, JSON.stringify(item.goal), f.task.id);
      const result = await readAgentPanel(f.scope, item.agent);
      expect(result.tasks[0].display_title).toBe(item.title);
      expect(result.tasks[0]).not.toHaveProperty('goal_json');
      expect(result.tasks[0]).not.toHaveProperty('assignment_id');
    }
  });
  it('recovers a historical article title from its saved assignment when the job is gone', async () => {
    const f = await fixture();
    f.sqlite.exec(`create table jobs(id text,site_id text,topic_id text,decision_item_id text,en_title text,pt_title text);
      create table topic_decision_items(id text,title_direction text);
      create table topics(id text,title_hint text);`);
    f.sqlite.prepare("update agent_tasks set agent_id='article_production', goal_json=?, assignment_id='brief-1' where id=?")
      .run(JSON.stringify({ job_id: 'removed-job' }), f.task.id);
    f.sqlite.prepare("update agent_runs set agent_id='article_production' where id=?").run(f.task.active_run_id);
    f.sqlite.prepare("insert into agent_task_assignments(id,task_id,operation_id,context_json,created_at) values('brief-1',?,'brief-1',?,'now')")
      .run(f.task.id, JSON.stringify({ topic: { title_hint: 'Saved reader topic' } }));
    const list = await readAgentPanel(f.scope, 'article_production');
    const detail = await readAgentPanelTask(f.scope, 'article_production', f.task.id);
    expect(list.tasks[0].display_title).toBe('Write article · Saved reader topic');
    expect(detail?.task.display_title).toBe(list.tasks[0].display_title);
  });
  it('reads actual saved domain workspace, output, and existing execution controls without model messages', async () => {
    const f = await fixture();
    const output = { summary: 'Saved results', evidence: ['https://example.org/evidence'], content: 'large'.repeat(15000) };
    const stored = await persistRuntimeJson(f.db, output);
    await f.db.prepare("update agent_tasks set workspace_json=?, output_json=? where id=?")
      .bind(JSON.stringify({ blueprint: { roadmap: 'Verify reader demand first' }, internal: 'not a business draft' }), stored, f.task.id).run();
    const result = await readAgentPanelTask(f.scope, 'strategy_research', f.task.id);
    expect(result?.draft?.content).toEqual({ blueprint: { roadmap: 'Verify reader demand first' } });
    expect(result?.output).toEqual(output);
    expect(result?.execution.allowed_actions).toEqual(['cancel']);
    expect(result).not.toHaveProperty('messages');
    expect(result?.goal).toEqual({ locale: 'en' });
  });
  it('shows the author-owned saved draft and current assignment without copying Runtime state', async () => {
    const f = await fixture();
    f.sqlite.prepare("update agent_runs set agent_id='article_production' where id=?").run(f.task.active_run_id);
    f.sqlite.prepare("update agent_tasks set agent_id='article_production', assignment_id='brief-1' where id=?").run(f.task.id);
    f.sqlite.prepare("insert into agent_task_assignments(id,task_id,operation_id,context_json,created_at) values('brief-1',?,'brief-1',?,'now')")
      .run(f.task.id, JSON.stringify({ topic: { title_direction: 'Reader question' }, editorial_brief: 'Use primary sources', source_locale: 'en', internal: 'not displayed' }));
    const bundle = { versions: [{ locale: 'en', title: 'Draft title', content: '# Real saved prose' }] };
    const slot = await persistRuntimeJson(f.db, { assignment_id: 'brief-1', bundle, editorial: { sources: ['primary evidence'] } });
    f.sqlite.prepare("insert into agent_parameter_slots(task_id,ref,kind,value_json) values(?,'draft-1','article_draft',?)").run(f.task.id, slot);
    const result = await readAgentPanelTask(f.scope, 'article_production', f.task.id);
    expect(result?.draft?.content).toEqual({ bundle, evidence: { sources: ['primary evidence'] } });
    expect(result?.goal).toMatchObject({ editorial_brief: 'Use primary sources', source_locale: 'en' });
    expect(result?.goal).not.toHaveProperty('internal');
  });
  it('returns the owning run files, never a newer strategy from another task or site', async () => {
    const f = await fixture();
    f.sqlite.prepare("insert into seo_strategy_versions values('owned','s',?,'active','pt-BR',2)").run(f.task.active_run_id);
    f.sqlite.exec("insert into seo_strategy_versions values('newer','s','another-run','active','pt-BR',3),('foreign','other','run-1','active','en',4)");
    f.sqlite.exec("insert into seo_strategy_documents values('own-file','owned','strategy','# Owned version','today'),('own-notes','owned','research_notes','Source evidence','today'),('old-keywords','owned','keyword_map','Obsolete keyword report','today'),('new-file','newer','strategy','# New version','today'),('foreign-file','foreign','strategy','# Private','today')");
    const result = await readAgentPanelTask(f.scope, 'strategy_research', f.task.id);
    expect(result?.files).toEqual([{ id: 'own-file', title: 'SEO strategy', category: 'Strategy documents', locale: 'pt-BR', version: 2, body: '# Owned version\n\n---\n\n## Research Basis and Sources\n\nSource evidence', date: 'today' }]);
  });
  it('reads delivered article bodies from scoped artifacts instead of the task receipt', async () => {
    const f = await fixture();
    f.sqlite.prepare("update agent_runs set agent_id='article_production' where id=?").run(f.task.active_run_id);
    f.sqlite.prepare("update agent_tasks set agent_id='article_production',status='completed' where id=?").run(f.task.id);
    f.sqlite.exec("insert into content_production_groups(id,workspace_id,site_id) values('group','w','s'),('foreign','other','s')");
    const body = JSON.stringify([{ locale: 'en', title: 'Delivered article', content: '# Final article' }]);
    f.sqlite.prepare("insert into content_artifacts values('article','group',?,?,1,'accepted','today')").run(f.task.active_run_id, body);
    f.sqlite.prepare("insert into content_artifacts values('private','foreign',?,?,2,'accepted','today')").run(f.task.active_run_id, body);
    const result = await readAgentPanelTask(f.scope, 'article_production', f.task.id);
    expect(result?.files).toEqual([{ id: 'article:en', title: 'Delivered article', category: 'Articles', locale: 'en', version: 1, body: '# Final article', date: 'today' }]);
  });
  it('does not return another site, workspace, or agent task', async () => {
    const f = await fixture();
    expect(await readAgentPanelTask({ ...f.scope, workspaceId: 'other' }, 'strategy_research', f.task.id)).toBeNull();
    expect(await readAgentPanelTask({ ...f.scope, siteId: 'other' }, 'strategy_research', f.task.id)).toBeNull();
    expect(await readAgentPanelTask(f.scope, 'article_production', f.task.id)).toBeNull();
    expect((await readAgentPanel({ ...f.scope, workspaceId: 'other' }, 'strategy_research')).tasks).toEqual([]);
  });
  it('keeps all open work visible and paginates tied history timestamps without skipping tasks', async () => {
    const f = await fixture();
    for (let i = 0; i < 35; i++) {
      const run = f.run(`history-${String(i).padStart(2, '0')}`, `strategy:${i}`);
      await attachTask(f.db, run, agentDefinition('strategy_research'));
      f.sqlite.prepare("update agent_tasks set status='completed', created_at='2026-09-19T10:00:00Z' where id=?").run(run.id);
    }
    const first = await readAgentPanel(f.scope, 'strategy_research');
    expect(first.tasks.filter(t => t.status === 'running')).toHaveLength(1);
    expect(first.tasks.filter(t => t.status === 'completed')).toHaveLength(30);
    const second = await readAgentPanel(f.scope, 'strategy_research', first.next_cursor!);
    expect(second.tasks.filter(t => t.status === 'completed')).toHaveLength(5);
    expect(new Set([...first.tasks, ...second.tasks].map(t => t.id)).size).toBe(36);
    expect(second.next_cursor).toBeNull();
  });
});
