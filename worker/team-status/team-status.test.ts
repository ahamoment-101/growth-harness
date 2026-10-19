// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { markSeen, readTeamStatus } from './index';
import { mergeBubbles } from './merge';
import type { TeamSignal } from './signals';
import { taskSignals, type TaskFact } from './task-rules';

const task = (over: Partial<TaskFact> & Pick<TaskFact, 'id' | 'agent_id' | 'status'>): TaskFact => ({
  outcome: '', parent_task_id: '', parent_agent_id: '', updated_at: '2026-09-19T10:00:00.000Z', ...over,
});
const signal = (over: Partial<TeamSignal> & Pick<TeamSignal, 'agent_id' | 'kind'>): TeamSignal => ({
  reason: 'working', count: 1, peer_agent_id: '', at: '2026-09-19T10:00:00.000Z', ...over,
});
const summary = (signals: TeamSignal[]) => signals.map((s) => [s.agent_id, s.kind, s.reason, s.peer_agent_id]);

describe('Task bubble rules', () => {
  it('does not infer that a running parent is waiting merely because it has a child', () => {
    expect(summary(taskSignals([
      task({ id: 'p', agent_id: 'content_production', status: 'running' }),
      task({ id: 'c', agent_id: 'article_production', status: 'running', parent_task_id: 'p', parent_agent_id: 'content_production' }),
    ]))).toEqual([
      ['content_production', 'working', 'working', ''],
      ['article_production', 'working', 'working', ''],
    ]);
  });
  it('distinguishes a saved child delivery from a defer and reveals the wait after reading', () => {
    const child = task({ id: 'c', agent_id: 'article_production', status: 'waiting', outcome: 'submitted', parent_task_id: 'p', parent_agent_id: 'content_production' });
    expect(taskSignals([child])[0].kind).toBe('just_done');
    expect(taskSignals([{ ...child, seen: 1 }])[0].reason).toBe('waiting_assignment');
    expect(taskSignals([{ ...child, outcome: 'deferred' }])[0].reason).toBe('waiting_assignment');
  });
  it('separates recovery, external waits, blocked work, and cancellation', () => {
    expect(summary(taskSignals([
      task({ id: 'a', agent_id: 'a', status: 'running', outcome: 'execution_recovering' }),
      task({ id: 'b', agent_id: 'b', status: 'paused', outcome: 'external_pending' }),
      task({ id: 'c', agent_id: 'c', status: 'completed', outcome: 'unable_to_complete' }),
      task({ id: 'd', agent_id: 'd', status: 'cancelled' }),
    ]))).toEqual([['a', 'working', 'recovering', ''], ['b', 'waiting_external', 'external_result', ''], ['c', 'stuck', 'agent_blocked', '']]);
  });
});

describe('Latest effective bubble', () => {
  it('lets a newer completion cover an older action and retains its exact task reference', () => {
    expect(mergeBubbles([
      signal({ agent_id: 'a', kind: 'needs_you', at: '2026-09-19T09:00:00Z' }),
      signal({ agent_id: 'a', task_id: 'done', kind: 'just_done', reason: 'delivered', at: '2026-09-19T10:00:00Z' }),
      signal({ agent_id: 'outside', kind: 'stuck' }),
    ], ['a'])).toEqual([expect.objectContaining({ task_id: 'done', kind: 'just_done' })]);
  });
  it('does not mix unrelated task counts or let a larger old group override the latest item', () => {
    expect(mergeBubbles([
      signal({ agent_id: 'a', kind: 'needs_you', count: 20, at: '2026-09-19T09:00:00Z' }),
      signal({ agent_id: 'a', kind: 'working', count: 1, at: '2026-09-19T10:00:00Z' }),
    ], ['a'])[0]).toMatchObject({ kind: 'working', count: 1 });
  });
});

function siteDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    create table sites (id text primary key);
    create table agent_tasks (id text primary key, workspace_id text not null, site_id text not null, agent_id text not null,
      status text not null, outcome text not null default '', parent_task_id text not null default '', created_at text not null, updated_at text not null);
    create table jobs (id text primary key, site_id text not null, status text not null, updated_at text not null);
    create table topic_decision_results (id text primary key, workspace_id text not null, site_id text not null, status text not null, updated_at text not null);
    insert into sites values ('site-a');
    ${readFileSync(new URL('../../migrations/0061_team_status_seen.sql', import.meta.url).pathname, 'utf8')}
    ${readFileSync(new URL('../../migrations/0062_team_status_receipts.sql', import.meta.url).pathname, 'utf8')}
    ${readFileSync(new URL('../../migrations/0064_work_requests.sql', import.meta.url).pathname, 'utf8')}
    create table team_status_revisions(workspace_id text not null,site_id text not null,revision integer not null default 0,primary key(workspace_id,site_id));
  `);
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values as never[]).changes } }),
  });
  return { sqlite, db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database };
}

const TEAM = ['content_production', 'article_production', 'topic_decision', 'deep_research'];
const insertTask = (sqlite: DatabaseSync, row: [string, string, string, string, string, string, string, string, string]) =>
  sqlite.prepare('insert into agent_tasks values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...row);

describe('Team status for a site', () => {
  it('restores the old todo after reading a newer completion, without changing business state', async () => {
    const { sqlite, db } = siteDb();
    const scope = { db, workspaceId: 'ws-a', siteId: 'site-a' };
    sqlite.exec("insert into jobs values ('j1', 'site-a', 'awaiting_review', '2026-09-19T08:00:00Z')");
    insertTask(sqlite, ['done', 'ws-a', 'site-a', 'content_production', 'completed', 'done', '', '2026-09-19T09:00:00Z', '2026-09-19T10:00:00Z']);
    expect((await readTeamStatus(scope, TEAM)).bubbles[0]).toMatchObject({ kind: 'just_done', task_id: 'done' });
    await markSeen(scope, 'content_production', 'done', '2026-09-19T10:00:00Z');
    expect((await readTeamStatus(scope, TEAM)).bubbles[0]).toMatchObject({ kind: 'needs_you', reason: 'review_articles', count: 1 });
    expect(sqlite.prepare('select status from jobs').get()).toEqual({ status: 'awaiting_review' });
  });
  it('preserves unread old completions through new work and acknowledges only the displayed version', async () => {
    const { sqlite, db } = siteDb(); const scope = { db, workspaceId: 'ws-a', siteId: 'site-a' };
    insertTask(sqlite, ['old', 'ws-a', 'site-a', 'topic_decision', 'completed', 'done', '', '2026-09-18T09:00:00Z', '2026-09-18T10:00:00Z']);
    insertTask(sqlite, ['new', 'ws-a', 'site-a', 'topic_decision', 'completed', 'done', '', '2026-09-19T09:00:00Z', '2026-09-19T10:00:00Z']);
    await markSeen(scope, 'topic_decision', 'new', '2026-09-19T09:59:59Z');
    expect((await readTeamStatus(scope, TEAM)).bubbles[0].task_id).toBe('new');
    await markSeen(scope, 'topic_decision', 'new', '2026-09-19T10:00:00Z');
    await markSeen(scope, 'topic_decision', 'new', '2026-09-19T10:00:00Z');
    expect((await readTeamStatus(scope, TEAM)).bubbles[0].task_id).toBe('old');
    expect(sqlite.prepare('select count(*) n from team_status_receipts').get()).toEqual({ n: 1 });
  });
  it('rejects mismatched scope or agent receipts and never dismisses a pending action', async () => {
    const { sqlite, db } = siteDb(); const scope = { db, workspaceId: 'ws-a', siteId: 'site-a' };
    insertTask(sqlite, ['waiting', 'ws-a', 'site-a', 'topic_decision', 'waiting', 'deferred', '', '2026-09-19T09:00:00Z', '2026-09-19T10:00:00Z']);
    insertTask(sqlite, ['other', 'ws-b', 'site-a', 'topic_decision', 'completed', 'done', '', '2026-09-19T09:00:00Z', '2026-09-19T10:00:00Z']);
    await markSeen(scope, 'topic_decision', 'waiting', '2026-09-19T10:00:00Z');
    await markSeen(scope, 'topic_decision', 'other', '2026-09-19T10:00:00Z');
    await markSeen(scope, 'deep_research', 'waiting', '2026-09-19T10:00:00Z');
    expect(sqlite.prepare('select count(*) n from team_status_receipts').get()).toEqual({ n: 0 });
    expect((await readTeamStatus(scope, TEAM)).bubbles).toEqual([expect.objectContaining({ task_id: 'waiting', kind: 'needs_you' })]);
  });
  it('reads child delivery once and returns to its parent wait', async () => {
    const { sqlite, db } = siteDb(); const scope = { db, workspaceId: 'ws-a', siteId: 'site-a' };
    insertTask(sqlite, ['p', 'ws-a', 'site-a', 'content_production', 'running', '', '', '2026-09-19T09:00:00Z', '2026-09-19T09:00:00Z']);
    insertTask(sqlite, ['c', 'ws-a', 'site-a', 'article_production', 'waiting', 'submitted', 'p', '2026-09-19T09:00:00Z', '2026-09-19T10:00:00Z']);
    expect((await readTeamStatus(scope, TEAM)).bubbles.find(b => b.agent_id === 'article_production')?.kind).toBe('just_done');
    await markSeen(scope, 'article_production', 'c', '2026-09-19T10:00:00Z');
    expect((await readTeamStatus(scope, TEAM)).bubbles.find(b => b.agent_id === 'article_production')?.reason).toBe('waiting_assignment');
  });
});
