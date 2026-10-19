// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { appendAgentEvent, getAgentRunByWorkflowId } from './store';

function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    create table agent_runs (
      id text primary key,
      workflow_id text not null default '',
      event_seq integer not null default 0,
      created_at text not null default '',
      updated_at text not null
    );
    create table agent_events (
      id text primary key,
      run_id text not null,
      seq integer not null,
      event_key text not null,
      kind text not null,
      phase text not null,
      actor_type text not null,
      actor_id text not null,
      payload_json text not null,
      created_at text not null,
      unique (run_id, seq),
      unique (run_id, event_key)
    );
    insert into agent_runs (id, event_seq, updated_at) values ('run-1', 0, '');
  `);
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    return {
      bind: (...next: unknown[]) => {
        values = next;
        return {
          first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
          run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values as never[]).changes } }),
        };
      },
    };
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
  };
}

describe('agent runtime event store', () => {
  it('returns the original event for an idempotent replay without advancing seq', async () => {
    const { db, sqlite } = sqliteD1();
    const input = {
      runId: 'run-1', eventKey: 'context.ready', kind: 'context_ready', phase: 'ready',
      actorType: 'workflow' as const, payload: { stable: true }, at: '2026-08-24T00:00:00.000Z',
    };

    const first = await appendAgentEvent(db, input);
    const replay = await appendAgentEvent(db, input);

    expect(replay.id).toBe(first.id);
    expect(replay.seq).toBe(1);
    expect(sqlite.prepare('select event_seq from agent_runs where id = ?').get('run-1')).toEqual({ event_seq: 1 });
    expect(sqlite.prepare('select count(*) as count from agent_events').get()).toEqual({ count: 1 });
  });

  it('assigns gap-free monotonic sequence numbers to different events', async () => {
    const { db, sqlite } = sqliteD1();
    await appendAgentEvent(db, {
      runId: 'run-1', eventKey: 'one', kind: 'test', phase: 'one', actorType: 'workflow',
    });
    await appendAgentEvent(db, {
      runId: 'run-1', eventKey: 'two', kind: 'test', phase: 'two', actorType: 'workflow',
    });

    expect(sqlite.prepare('select seq from agent_events order by seq').all()).toEqual([{ seq: 1 }, { seq: 2 }]);
  });

  it('resolves a late callback to its workflow instead of the Agent current Run', async () => {
    const { db, sqlite } = sqliteD1();
    sqlite.exec(`
      update agent_runs set workflow_id = 'workflow-old', created_at = '2026-08-24T00:00:00.000Z' where id = 'run-1';
      insert into agent_runs (id, workflow_id, created_at, updated_at)
      values ('run-2', 'workflow-new', '2026-08-24T01:00:00.000Z', '');
    `);
    await expect(getAgentRunByWorkflowId(db, 'workflow-old')).resolves.toMatchObject({ id: 'run-1' });
    await expect(getAgentRunByWorkflowId(db, 'missing')).resolves.toBeNull();
  });
});
