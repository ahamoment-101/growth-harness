import { describe, expect, it } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';

function fixture() {
  const f = schemaTestDb();
  f.insert('sites', { id: 's', workspace_id: 'w', name: 'Site', ingest_url: 'https://example.invalid' });
  const changes = () => f.sqlite.prepare('select workspace_id,site_id,kind,ref from site_changes order by seq').all() as Array<Record<string, string>>;
  const clear = () => f.sqlite.exec('delete from site_changes');
  const task = (id: string, agent = 'strategy_research', extra: Record<string, unknown> = {}) =>
    f.insert('agent_tasks', { id, workspace_id: 'w', site_id: 's', agent_id: agent, agent_instance_id: id, active_run_id: `run-${id}`, status: 'running', goal_json: '{}', created_at: '2026-01-01', updated_at: '2026-01-01', ...extra });
  return { ...f, changes, clear, task };
}

describe('site change log triggers', () => {
  it('logs task creation and visible state changes but not per-turn timestamp bumps', () => {
    const f = fixture();
    f.task('t1');
    expect(f.changes()).toEqual([{ workspace_id: 'w', site_id: 's', kind: 'task', ref: 't1' }]);
    f.clear();
    f.sqlite.exec("update agent_tasks set updated_at='2026-01-02', next_turn=next_turn+1 where id='t1'");
    expect(f.changes()).toEqual([]);
    f.sqlite.exec("update agent_tasks set status='waiting', updated_at='2026-01-03' where id='t1'");
    f.sqlite.exec("update agent_tasks set outcome='submitted' where id='t1'");
    f.sqlite.exec("update agent_tasks set reason='Waiting for review' where id='t1'");
    f.sqlite.exec("update agent_tasks set status='waiting' where id='t1'");
    expect(f.changes().map(c => c.kind)).toEqual(['task', 'task', 'task']);
  });
  it('logs Leader transcript rows only for Leader tasks, keyed by conversation', () => {
    const f = fixture();
    f.insert('leader_conversations', { id: 'conv', workspace_id: 'w', site_id: 's', title: 'T', created_at: '2026-01-01' });
    f.task('leader', 'growth_leader', { active_run_id: 'conv' });
    f.task('other');
    f.insert('agent_conversations', { task_id: 'leader' });
    f.insert('agent_conversations', { task_id: 'other' });
    f.clear();
    f.insert('agent_conversation_messages', { task_id: 'leader', sequence: 1, message_key: 'a', role: 'assistant', message_json: '{}', created_at: '2026-01-01' });
    f.insert('agent_conversation_messages', { task_id: 'other', sequence: 1, message_key: 'b', role: 'assistant', message_json: '{}', created_at: '2026-01-01' });
    f.insert('leader_inputs', { id: 'i1', conversation_id: 'conv', kind: 'user', actor_id: 'u', content: 'hi', created_at: '2026-01-01' });
    expect(f.changes()).toEqual([
      { workspace_id: 'w', site_id: 's', kind: 'leader_message', ref: 'conv' },
      { workspace_id: 'w', site_id: 's', kind: 'leader_input', ref: 'conv' },
    ]);
  });
  it('logs work requests, jobs, topic results, receipts and checkpoints', () => {
    const f = fixture();
    f.task('t1', 'article_production');
    f.insert('jobs', { id: 'j1', site_id: 's', status: 'drafting', created_at: '2026-01-01', updated_at: '2026-01-01' });
    f.insert('topic_decision_results', { id: 'r1', workspace_id: 'w', site_id: 's', decision_type: 'topic_group', status: 'draft', created_at: '2026-01-01', updated_at: '2026-01-01' });
    f.clear();
    f.insert('agent_work_requests', { task_id: 't1', request_id: 'q', handler_id: 'h', version: '1', state: 'pending', node_json: '{}', created_at: '2026-01-01', updated_at: '2026-01-01' });
    f.sqlite.exec("update agent_work_requests set state='resolved' where task_id='t1'");
    f.sqlite.exec("update jobs set status='awaiting_review' where id='j1'");
    f.sqlite.exec("update jobs set updated_at='2026-01-05' where id='j1'");
    f.sqlite.exec("update topic_decision_results set status='handed_off' where id='r1'");
    f.insert('team_status_receipts', { workspace_id: 'w', site_id: 's', agent_id: 'article_production', task_id: 't1', completed_at: '2026-01-01' });
    f.insert('agent_task_operations', { id: 'op', task_id: 't1', turn: 1, status: 'succeeded', context_json: '{}', created_at: '2026-01-01', updated_at: '2026-01-01' });
    f.insert('agent_task_checkpoints', { id: 'c1', task_id: 't1', operation_id: 'op', assignment_id: '', output_json: '{}', created_at: '2026-01-01' });
    expect(f.changes().map(c => `${c.kind}:${c.ref}`)).toEqual(['work_request:t1', 'work_request:t1', 'job:j1', 'topic_result:r1', 'receipt:t1', 'checkpoint:t1']);
  });
  it('keeps changes of different sites apart', () => {
    const f = fixture();
    f.insert('sites', { id: 's2', workspace_id: 'w2', name: 'Other', ingest_url: 'https://example.invalid' });
    f.task('t1');
    f.insert('agent_tasks', { id: 't2', workspace_id: 'w2', site_id: 's2', agent_id: 'strategy_research', agent_instance_id: 'x', active_run_id: 'r2', status: 'running', goal_json: '{}', created_at: '2026-01-01', updated_at: '2026-01-01' });
    expect(f.changes().map(c => `${c.site_id}:${c.ref}`)).toEqual(['s:t1', 's2:t2']);
  });
});

import { vi } from 'vitest';
import { pokeChangedSites, pokeSite, pruneSiteChanges, type RoomEnv } from './poke';
describe('minute backstop and retention', () => {
  it('pokes each changed site once per change, starting from the present', async () => {
    const f = fixture();
    const poked: string[] = [];
    const env = { DB: f.db, SITE_ROOM: { idFromName: (name: string) => name, get: () => ({ poke: async (siteId: string) => { poked.push(siteId); } }) } } as unknown as RoomEnv;
    f.task('before');
    await pokeChangedSites(env);
    expect(poked).toEqual([]);
    f.insert('sites', { id: 's2', workspace_id: 'w', name: 'Two', ingest_url: 'https://example.invalid' });
    f.task('t1'); f.task('t2');
    f.insert('agent_tasks', { id: 't3', workspace_id: 'w', site_id: 's2', agent_id: 'strategy_research', agent_instance_id: 'x', active_run_id: 'r3', status: 'running', goal_json: '{}', created_at: '2026-01-01', updated_at: '2026-01-01' });
    await pokeChangedSites(env);
    expect(poked.sort()).toEqual(['s', 's2']);
    await pokeChangedSites(env);
    expect(poked).toHaveLength(2);
  });
  it('removes only rows older than seven days', async () => {
    const f = fixture();
    f.task('t1'); f.task('t2');
    f.sqlite.exec("update site_changes set created_at='2026-01-01T00:00:00.000Z' where ref='t1'");
    await pruneSiteChanges({ DB: f.db }, Date.parse('2026-01-20T00:00:00Z'));
    expect(f.changes().map(c => c.ref)).toEqual(['t2']);
  });
  it('prunes a backlog larger than one batch in a single run', async () => {
    const f = fixture();
    f.sqlite.exec(`with recursive n(i) as (select 1 union all select i+1 from n where i<12000)
      insert into site_changes(workspace_id,site_id,kind,ref,created_at) select 'w','s','task','x','2026-01-01T00:00:00.000Z' from n`);
    f.task('fresh');
    await pruneSiteChanges({ DB: f.db }, Date.parse('2026-01-20T00:00:00Z'));
    expect(f.changes().map(c => c.ref)).toEqual(['fresh']);
  });
  it('throttles runtime pokes but always delivers the last one of a window', async () => {
    vi.useFakeTimers();
    try {
      const poked: number[] = [];
      const env = { DB: {} as never, SITE_ROOM: { idFromName: (n: string) => n, get: () => ({ poke: async () => { poked.push(Date.now()); } }) } } as unknown as RoomEnv;
      await pokeSite(env, 'throttle', { coalesce: true });
      await pokeSite(env, 'throttle', { coalesce: true });
      await pokeSite(env, 'throttle', { coalesce: true });
      expect(poked).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(poked).toHaveLength(2);
      await pokeSite(env, 'throttle');
      expect(poked).toHaveLength(3);
    } finally { vi.useRealTimers(); }
  });
});
