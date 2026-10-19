import { describe, expect, it } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import { dispatchPendingAgentEvents, pendingEventDeliveries, readAgentInbox } from './pool';
import type { RuntimeAgentEnv } from '../agent-runtime/env';

function fixture() {
  const f = schemaTestDb();
  f.insert('workspaces', { id: 'w', name: 'Workspace' });
  f.insert('sites', { id: 's', workspace_id: 'w', name: 'Site', ingest_url: 'https://example.invalid' });
  f.insert('jobs', { id: 'j', site_id: 's', status: 'drafting', current_artifact_id: 'a1', en_title: 'Article' });
  return f;
}

describe('agent event pool', () => {
  it('records an accepted article version and its subscribed delivery in the same job update', async () => {
    const f = fixture();
    f.sqlite.prepare("update jobs set status='awaiting_review' where id='j'").run();
    expect(f.sqlite.prepare('select type,subject_id,subject_version from agent_pool_events').all())
      .toEqual([{ type: 'content.article_ready_for_publication_review', subject_id: 'j', subject_version: 'a1' }]);
    expect(await pendingEventDeliveries(f.db, { workspaceId: 'w', siteId: 's', agentId: 'growth_leader' }, 'publication:s'))
      .toEqual([expect.objectContaining({ event_id: 'article-review:j:a1', status: 'pending' })]);
    f.sqlite.prepare("update jobs set status='awaiting_review' where id='j'").run();
    expect(f.sqlite.prepare('select count(*) n from agent_pool_events').get()).toEqual({ n: 1 });
    f.sqlite.prepare("update jobs set current_artifact_id='a2' where id='j'").run();
    expect(f.sqlite.prepare('select count(*) n from agent_pool_events').get()).toEqual({ n: 2 });
    expect(f.sqlite.prepare("select status from agent_event_deliveries where event_id='article-review:j:a1'").get())
      .toEqual({ status: 'superseded' });
  });

  it('uses subscriptions for routing and keeps an unread event after an interrupted dispatch', async () => {
    const f = fixture();
    f.sqlite.prepare("update agent_event_subscriptions set enabled=0 where agent_id='growth_leader' and type='content.article_ready_for_publication_review'").run();
    f.sqlite.prepare("update jobs set status='awaiting_review' where id='j'").run();
    expect(f.sqlite.prepare('select count(*) n from agent_pool_events').get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare('select count(*) n from agent_event_deliveries').get()).toEqual({ n: 0 });
    f.sqlite.prepare("update agent_event_subscriptions set enabled=1 where agent_id='growth_leader' and type='content.article_ready_for_publication_review'").run();
    // A subscription change does not silently backfill old events.
    expect(await readAgentInbox(f.db, { workspaceId: 'w', siteId: 's', agentId: 'growth_leader' }, 'publication:s')).toEqual([]);
  });

  it('marks an event delivered only after the conversation persists its observation', async () => {
    const f = fixture();
    f.sqlite.prepare("update jobs set status='awaiting_review' where id='j'").run();
    f.insert('agent_tasks', { id: 'leader-task', active_run_id: 'publication:s', workspace_id: 'w', site_id: 's',
      agent_id: 'growth_leader', definition_version: 3, status: 'running' });
    f.insert('agent_conversations', { task_id: 'leader-task', instructions: 'Test', context_json: '{}', created_at: new Date().toISOString() });
    f.insert('agent_conversation_messages', { task_id: 'leader-task', sequence: 1, message_key: 'event:article-review:j:a1',
      role: 'user', message_json: '{}', created_at: new Date().toISOString() });
    expect(f.sqlite.prepare("select status,target_run_id from agent_event_deliveries where event_id='article-review:j:a1'").get())
      .toEqual({ status: 'delivered', target_run_id: 'publication:s' });
    expect(await readAgentInbox(f.db, { workspaceId: 'w', siteId: 's', agentId: 'growth_leader' }, 'publication:s'))
      .toEqual([expect.objectContaining({ event_id: 'article-review:j:a1', status: 'delivered' })]);
    f.sqlite.prepare("update agent_event_deliveries set available_at='2020-01-01T00:00:00.000Z' where event_id='article-review:j:a1'").run();
    expect(await pendingEventDeliveries(f.db, { workspaceId: 'w', siteId: 's', agentId: 'growth_leader' }, 'publication:s'))
      .toEqual([expect.objectContaining({ event_id: 'article-review:j:a1', status: 'delivered' })]);
    f.insert('agent_conversation_messages', { task_id: 'leader-task', sequence: 2,
      message_key: 'event-followup:article-review:j:a1:2026-09-25', role: 'user', message_json: '{}', created_at: new Date().toISOString() });
    expect(f.sqlite.prepare("select available_at from agent_event_deliveries where event_id='article-review:j:a1'").get())
      .not.toEqual({ available_at: '2020-01-01T00:00:00.000Z' });
  });

  it('routes a child checkpoint to the subscribed parent Run without merging conversations', () => {
    const f = fixture();
    f.insert('agent_tasks', { id: 'parent', active_run_id: 'leader-run', workspace_id: 'w', site_id: 's',
      agent_id: 'growth_leader', definition_version: 3, status: 'waiting' });
    f.insert('agent_tasks', { id: 'child', active_run_id: 'child-run', parent_task_id: 'parent', workspace_id: 'w', site_id: 's',
      agent_id: 'content_production', status: 'running', execution_id: 'execution-1', assignment_id: 'assignment-1' });
    f.sqlite.prepare("update agent_tasks set status='waiting' where id='child'").run();
    expect(f.sqlite.prepare("select type,source_ref from agent_pool_events where subject_id='child'").get())
      .toEqual({ type: 'agent.task_report_ready', source_ref: 'leader-run' });
    expect(f.sqlite.prepare("select agent_id,target_run_id from agent_event_deliveries where event_id like 'task-report:%'").get())
      .toEqual({ agent_id: 'growth_leader', target_run_id: 'leader-run' });
  });

  it('routes an article review through its content task to the original Leader conversation', async () => {
    const f = fixture();
    f.sqlite.exec('pragma foreign_keys=off');
    f.insert('agent_tasks', { id: 'leader', active_run_id: 'original-leader-run', workspace_id: 'w', site_id: 's',
      agent_id: 'growth_leader', definition_version: 13, status: 'waiting' });
    f.insert('agent_tasks', { id: 'editor', active_run_id: 'content-run', parent_task_id: 'leader', workspace_id: 'w', site_id: 's',
      agent_id: 'content_production', status: 'running' });
    f.insert('content_production_groups', { id: 'group', workspace_id: 'w', site_id: 's', parent_run_id: 'content-run' });
    f.sqlite.prepare("update jobs set production_group_id='group',status='awaiting_review' where id='j'").run();
    expect(f.sqlite.prepare("select target_run_id from agent_event_deliveries where event_id='article-review:j:a1'").get())
      .toEqual({ target_run_id: 'original-leader-run' });
    expect(await pendingEventDeliveries(f.db, { workspaceId: 'w', siteId: 's', agentId: 'growth_leader' }, 'original-leader-run'))
      .toEqual([expect.objectContaining({ event_id: 'article-review:j:a1' })]);
    expect(await pendingEventDeliveries(f.db, { workspaceId: 'w', siteId: 's', agentId: 'growth_leader' }, 'publication:s')).toEqual([]);
    f.sqlite.prepare("update jobs set status='published' where id='j'").run();
    expect(f.sqlite.prepare("select type,subject_id from agent_pool_events where id='article-published:j:a1'").get())
      .toEqual({ type: 'content.article_published', subject_id: 'j' });
    expect(f.sqlite.prepare("select target_run_id from agent_event_deliveries where event_id='article-published:j:a1'").get())
      .toEqual({ target_run_id: 'original-leader-run' });
  });

  it('seeks the bounded due queue instead of scanning event history', () => {
    const f = fixture();
    const plan = f.sqlite.prepare(`explain query plan select event_id,agent_id from agent_event_deliveries
      where status in ('pending','delivered') and available_at<=? order by available_at,event_id limit 100`).all('2026-09-24') as Array<{ detail: string }>;
    expect(plan.map(row => row.detail).join(' | ')).toContain('agent_event_deliveries_due');
    expect(plan.some(row => row.detail.startsWith('SCAN agent_event_deliveries'))).toBe(false);
    const recipient = f.sqlite.prepare(`explain query plan select d.event_id from agent_event_deliveries d
      join agent_pool_events e on e.id=d.event_id where d.target_run_id=? and d.status=? and d.available_at<=?
      and d.workspace_id=? and d.site_id=? and d.agent_id=? order by d.available_at,d.event_id limit ?`)
      .all('', 'pending', '2026-09-24', 'w', 's', 'growth_leader', 20) as Array<{ detail: string }>;
    expect(recipient.map(row => row.detail).join(' | ')).toContain('agent_event_deliveries_run');
    expect(recipient.some(row => row.detail.includes('USE TEMP B-TREE'))).toBe(false);
  });

  it('starts one site work conversation only when the pool has a due delivery', async () => {
    const f = fixture();
    const created: string[] = [];
    const env = { DB: f.db, AGENT_RUNTIME_ENABLED: 'true', AGENT_WORKFLOW: { create: async ({ id }: {id:string}) => { created.push(id); return { id }; } } } as unknown as RuntimeAgentEnv;
    expect(await dispatchPendingAgentEvents(env)).toEqual({ pending: 0, woken: 0 });
    expect(created).toHaveLength(0);
    f.sqlite.prepare("update jobs set status='awaiting_review' where id='j'").run();
    expect(await dispatchPendingAgentEvents(env)).toEqual({ pending: 1, woken: 1 });
    expect(f.sqlite.prepare("select id,title from leader_conversations where id='publication:s'").get())
      .toEqual({ id: 'publication:s', title: 'Pre-publish review' });
    expect(f.sqlite.prepare("select agent_id,active_run_id from agent_tasks where active_run_id='publication:s'").get())
      .toEqual({ agent_id: 'growth_leader', active_run_id: 'publication:s' });
    expect(created).toHaveLength(1);
  });
});
