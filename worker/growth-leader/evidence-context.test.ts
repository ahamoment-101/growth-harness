import { describe, expect, it } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import type { AgentTask } from '../agent-runtime/task-store';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from '../agent-runtime/env';
import { agentDefinition } from '../agent-runtime/definitions';
import { leaderTools } from './tools';
import { leaderObservation, readLeaderTopics } from './evidence-context';

function fixture() {
  const f = taskTestDb();
  f.sqlite.exec(`create table content_production_groups(id text,decision_group_id text,workspace_id text,site_id text);
    insert into content_production_groups values('production','g','w','s');
    create table topic_decision_results(id text,workspace_id text,site_id text,run_id text,status text,scope_locale text,scope_market text,group_goal text,requested_count integer,reviewed_by text,review_note text,reviewed_at text,created_at text,updated_at text);
    create table topic_decision_items(id text,result_id text,title_direction text,primary_keyword text,locale text,market text,created_at text,job_id text,sort_order integer);
    create table jobs(id text,site_id text,status text,created_at text,published_at text,production_group_id text);
    insert into topic_decision_results values('g','w','s','historical','handed_off','en','global','Goal',10,'user','Only selected items','2026-09-17','2026-09-16','2026-09-17');
    insert into topic_decision_items values('one','g','First','keyword','en','global','2026-09-16','job',0);
    insert into topic_decision_items values('two','g','Second','keyword2','en','global','2026-09-16',null,1);
    insert into jobs values('job','s','published','2026-09-17','2026-09-18','production');`);
  const task = { id: 'leader', workspace_id: 'w', site_id: 's', definition_version: 7 } as AgentTask;
  return { ...f, task, env: { DB: f.db } as RuntimeAgentEnv };
}

describe('Leader evidence environment', () => {
  it('returns actual topics and review records without inventing requested-but-absent items or eligibility', async () => {
    const f = fixture();
    const result = await readLeaderTopics(f.env, f.task, 'g', 0);
    expect(result).toMatchObject({ group: { requested_count: 10, actual_item_count: 2, items_without_job_reference: 1, linked_items_by_job_status_json: '{"published":1}', production_group_ref: 'production', review_note: 'Only selected items' },
      items: [{ topic_ref: 'one', job_status: 'published', published_at: '2026-09-18' }, { topic_ref: 'two', job_id: null, job_status: null }], next_offset: null });
    expect(JSON.stringify(result)).not.toContain('eligible');
    f.sqlite.exec("update jobs set site_id='other'");
    expect(await readLeaderTopics(f.env, f.task, 'g', 0)).toMatchObject({ items: [{ job_status: null }, {}] });
    await expect(readLeaderTopics(f.env, { ...f.task, site_id: 'other' }, 'g', 0)).rejects.toThrow('not found');
  });

  it('exposes the next page instead of implying that a partial list is complete', async () => {
    const f = fixture();
    const insert = f.sqlite.prepare('insert into topic_decision_items values(?,?,?,?,?,?,?,?,?)');
    for (let n = 2; n < 52; n++) insert.run(`item-${n}`, 'g', 'Topic', 'keyword', 'en', 'global', '2026-09-16', null, n);
    const first = await readLeaderTopics(f.env, f.task, 'g', 0);
    expect(first).toMatchObject({ next_offset: 50 });
    expect('items' in first && first.items).toHaveLength(50);
    const last = await readLeaderTopics(f.env, f.task, 'g', 50);
    expect(last).toMatchObject({ next_offset: null });
    expect('items' in last && last.items).toHaveLength(2);
  });

  it('versions the Leader tool contract and attributes reads without changing old tools', async () => {
    const f = fixture();
    const read = (version: number) => leaderTools(f.env, {} as RuntimeWorkflowStep, { ...f.task, definition_version: version }).resolve(agentDefinition('growth_leader'), 'read_workspace');
    expect(read(6).inputSchema.safeParse({ section: 'topic_groups' }).success).toBe(false);
    expect(read(6).version).toBe(2);
    const tool = read(7);
    expect(tool.version).toBe(3);
    const result = await tool.execute!(tool.inputSchema.parse({ section: 'topic_groups', target_ref: 'g' }), { runId: 'leader', workspaceId: 'w', siteId: 's', idempotencyKey: 'test' });
    expect(result).toMatchObject({ observation: { kind: 'workspace_records', source: 'read_workspace:topic_groups:g:offset=0' }, data: { group: { target_ref: 'g' } } });
  });

  it('keeps a member claim attributed rather than certifying it as an executed action', () => {
    const result = leaderObservation('task_report', 'read_task:old', { reason: 'Ten topics delivered' }, '2026-09-25');
    expect(result.observation.meaning).toContain('member-reported');
    expect(result.data).toEqual({ reason: 'Ten topics delivered' });
    expect(result.observation.observed_at).toBe('2026-09-25');
  });
});
