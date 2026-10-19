// @ts-ignore Node test-only module.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import { SiteProjection, type RoomSql } from './projection';
import { readTeamStatus } from '../team-status';
import { markSeen } from '../team-status/seen';
import { readAgentActivity } from '../team-status/activity';
import { listConversations, readLeaderDetail } from '../growth-leader/service';
import { agentRoster } from '../agent-runtime/definitions';
import type { RuntimeAgentEnv } from '../agent-runtime/env';

function roomSql(): RoomSql {
  const db = new DatabaseSync(':memory:');
  return { exec: <T>(sql: string, ...params: unknown[]) => {
    const statement = db.prepare(sql);
    return (/^\s*select/i.test(sql) ? statement.all(...params as never[]) : (statement.run(...params as never[]), [])) as T[];
  } };
}

let clock = 0;
const at = () => new Date(Date.UTC(2026, 0, 1) + (++clock) * 1000).toISOString();

function fixture() {
  const f = schemaTestDb();
  f.insert('sites', { id: 's', workspace_id: 'w', name: 'Site', ingest_url: 'https://example.invalid' });
  f.insert('sites', { id: 'other', workspace_id: 'w2', name: 'Other', ingest_url: 'https://example.invalid' });
  const scope = { db: f.db, workspaceId: 'w', siteId: 's' };
  const env = { DB: f.db } as unknown as RuntimeAgentEnv;
  const room = new SiteProjection(roomSql(), env, 's', 'v1');
  const task = (id: string, agent: string, extra: Record<string, unknown> = {}) => {
    const now = at();
    f.insert('agent_tasks', { id, workspace_id: 'w', site_id: 's', agent_id: agent, agent_instance_id: id, active_run_id: `run-${id}`, status: 'running', goal_json: '{}', created_at: now, updated_at: now, ...extra });
  };
  const update = (id: string, fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    f.sqlite.prepare(`update agent_tasks set ${keys.map(k => `${k}=?`).join(',')},updated_at=? where id=?`).run(...keys.map(k => fields[k]) as never[], at(), id);
  };
  return { ...f, scope, env, room, task, update };
}

describe('SiteRoom projection', () => {
  it('counts the classroom Leader human request and removes it when resolved', async () => {
    const f = fixture();
    f.task('leader', 'growth_leader', { status: 'waiting' });
    expect((await f.room.subscribe('team'))!.data).toMatchObject({ figures: { pending: 0 } });
    f.insert('agent_work_requests', { task_id: 'leader', request_id: 'owner-review', handler_id: 'hitl',
      version: '1', state: 'pending', node_json: '{}', created_at: at(), updated_at: at() });
    await f.room.catchUp();
    expect(f.room.state('team')!.data).toMatchObject({ figures: { pending: 1 } });
    f.sqlite.exec("update agent_work_requests set state='resolved' where task_id='leader'");
    await f.room.catchUp();
    expect(f.room.state('team')!.data).toMatchObject({ figures: { pending: 0 } });
  });

  // Bubble time is the task's last visible change (docs §7.2): per-turn updated_at bumps do not log a change,
  // so the room matches the HTTP read at every logged change, not between them.
  it('keeps team status equal to the HTTP view at every task, request, queue and receipt change', async () => {
    const f = fixture();
    const team = agentRoster().map(member => member.agentId);
    const expectSame = async () => expect(f.room.state('team')!.data).toEqual(await readTeamStatus(f.scope, team));
    f.task('research', 'strategy_research');
    expect((await f.room.subscribe('team'))!.data).toEqual(await readTeamStatus(f.scope, team));

    f.task('topics', 'topic_decision');
    expect(await f.room.catchUp()).toContain('team');
    await expectSame();

    f.update('research', { status: 'completed', outcome: 'completed' });
    await f.room.catchUp(); await expectSame();

    const done = f.sqlite.prepare("select updated_at from agent_tasks where id='research'").get() as { updated_at: string };
    await markSeen(f.scope, 'strategy_research', 'research', done.updated_at);
    await f.room.catchUp(); await expectSame();

    f.insert('agent_work_requests', { task_id: 'topics', request_id: 'q', handler_id: 'h', version: '1', state: 'pending', node_json: '{}', created_at: at(), updated_at: at() });
    await f.room.catchUp(); await expectSame();
    f.sqlite.exec("update agent_work_requests set state='resolved' where task_id='topics'");
    await f.room.catchUp(); await expectSame();

    f.insert('jobs', { id: 'j1', site_id: 's', status: 'drafting', created_at: at(), updated_at: at() });
    f.sqlite.prepare("update jobs set status='awaiting_review',updated_at=? where id='j1'").run(at());
    f.insert('topic_decision_results', { id: 'r1', workspace_id: 'w', site_id: 's', decision_type: 'topic_group', status: 'draft', created_at: at(), updated_at: at() });
    await f.room.catchUp(); await expectSame();

    f.update('topics', { status: 'cancelled', outcome: 'cancelled' });
    await f.room.catchUp(); await expectSame();
    expect(await f.room.catchUp()).toEqual([]);
  });

  it('keeps the activity feed equal to the HTTP view and ignores changes that are not milestones', async () => {
    const f = fixture();
    f.task('a', 'strategy_research');
    await f.room.subscribe('activity');
    f.task('b', 'topic_decision');
    expect(await f.room.catchUp()).toContain('activity');
    expect(f.room.state('activity')!.data).toEqual(await readAgentActivity(f.scope));
    const feedReads = () => f.executions("'0:start:'||t.id");
    const before = feedReads();
    f.update('a', { status: 'waiting', outcome: 'submitted' });
    f.update('b', { reason: 'Reading the strategy' });
    expect(await f.room.catchUp()).toEqual([]);
    // Non-milestone changes of tasks already in the feed do not rebuild it.
    expect(feedReads()).toBe(before);
    f.update('a', { status: 'completed', outcome: 'completed' });
    expect(await f.room.catchUp()).toContain('activity');
    expect(f.room.state('activity')!.data).toEqual(await readAgentActivity(f.scope));
  });

  it('keeps the Leader list and a conversation equal to the HTTP views', async () => {
    const f = fixture();
    const message = (task: string, sequence: number, text: string) => f.insert('agent_conversation_messages', { task_id: task, sequence, message_key: `m${sequence}`, role: 'assistant', created_at: at(),
      message_json: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now() }) });
    f.insert('leader_conversations', { id: 'conv', workspace_id: 'w', site_id: 's', title: 'Growth', created_at: at() });
    f.task('leader', 'growth_leader', { active_run_id: 'conv', status: 'waiting', outcome: 'leader_ready' });
    f.insert('agent_conversations', { task_id: 'leader' });
    message('leader', 1, 'Hello');
    await f.room.subscribe('leader.list');
    await f.room.subscribe('leader.conv:conv');
    const same = async () => {
      expect(f.room.state('leader.list')!.data).toEqual({ conversations: await listConversations(f.env, f.scope) });
      expect(f.room.state('leader.conv:conv')!.data).toEqual(await readLeaderDetail(f.env, f.scope, 'conv', { tail: 200 }));
    };
    await same();

    f.insert('leader_inputs', { id: 'i1', conversation_id: 'conv', kind: 'user', actor_id: 'u', content: 'Research customers', created_at: at() });
    expect(await f.room.catchUp()).toEqual(expect.arrayContaining(['leader.list', 'leader.conv:conv']));
    await same();

    f.task('child', 'deep_research', { parent_task_id: 'leader', goal_json: JSON.stringify({ delegation: { goal: 'Find needs', reason: 'Positioning' } }) });
    message('leader', 2, 'Delegated.');
    await f.room.catchUp(); await same();

    f.update('child', { status: 'completed', outcome: 'completed' });
    await f.room.catchUp(); await same();
    expect((f.room.state('leader.list')!.data as { conversations: Array<{ team_active: number; team_delivered: number; team_total: number }> }).conversations[0])
      .toMatchObject({ team_active: 0, team_delivered: 1, team_total: 1 });
  });

  it('keeps delegated members in their originating Leader conversation', async () => {
    const f = fixture();
    for (const id of ['first', 'second']) {
      f.insert('leader_conversations', { id, workspace_id: 'w', site_id: 's', title: id, created_at: at() });
      f.task(`leader-${id}`, 'growth_leader', { active_run_id: id });
      f.task(`child-${id}`, 'deep_research', { parent_task_id: `leader-${id}` });
    }
    const first = await f.room.subscribe('leader.conv:first');
    const second = await f.room.subscribe('leader.conv:second');
    expect((first?.data as { tasks: Array<{ id: string }> }).tasks.map(task => task.id)).toEqual(['child-first']);
    expect((second?.data as { tasks: Array<{ id: string }> }).tasks.map(task => task.id)).toEqual(['child-second']);
    expect((await f.room.subscribe('leader.list'))?.data).toEqual({ conversations: await listConversations(f.env, f.scope) });
  });

  it('refuses conversations of another site and forgets dropped topics', async () => {
    const f = fixture();
    f.insert('leader_conversations', { id: 'foreign', workspace_id: 'w2', site_id: 'other', title: 'X', created_at: at() });
    expect(await f.room.subscribe('leader.conv:foreign')).toBeNull();
    expect(await f.room.subscribe('not-a-topic')).toBeNull();
    await f.room.subscribe('team');
    f.room.drop('team');
    expect(f.room.builtTopics()).toEqual([]);
  });

  it('starts a new room at the present and applies each change once', async () => {
    const f = fixture();
    f.task('old', 'strategy_research');
    await f.room.catchUp();
    await f.room.subscribe('team');
    f.task('new', 'topic_decision');
    expect(await f.room.catchUp()).toEqual(['team']);
    expect(await f.room.catchUp()).toEqual([]);
  });

  it('orders bubbles by the last visible change and ignores per-turn timestamp bumps', async () => {
    const f = fixture();
    f.task('a', 'article_production'); f.task('b', 'article_production');
    await f.room.subscribe('team');
    const shown = () => (f.room.state('team')!.data as { bubbles: Array<{ agent_id: string; task_id: string }> }).bubbles.find(b => b.agent_id === 'article_production')?.task_id;
    expect(shown()).toBe('b');
    f.sqlite.prepare("update agent_tasks set updated_at=?, next_turn=next_turn+1 where id='a'").run(at());
    expect(await f.room.catchUp()).toEqual([]);
    expect(shown()).toBe('b');
    f.update('a', { reason: 'Drafting section two' });
    await f.room.catchUp();
    expect(shown()).toBe('a');
  });

  it('drops every stored topic when the code version changes', async () => {
    const f = fixture();
    const sql = roomSql();
    const first = new SiteProjection(sql, f.env, 's', 'deploy-1');
    await first.subscribe('team'); await first.subscribe('activity');
    expect(new SiteProjection(sql, f.env, 's', 'deploy-1').builtTopics().sort()).toEqual(['activity', 'team']);
    expect(new SiteProjection(sql, f.env, 's', 'deploy-2').builtTopics()).toEqual([]);
  });

  it('counts every change row read, including catch-ups inside a rebuild', async () => {
    const f = fixture();
    await f.room.catchUp();
    f.task('x', 'strategy_research'); f.task('y', 'topic_decision');
    await f.room.catchUp();
    f.task('z', 'strategy_research');
    await f.room.subscribe('team');
    expect(f.room.processed).toBe(3);
  });
});
