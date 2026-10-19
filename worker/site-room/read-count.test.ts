// @ts-ignore Node test-only module.
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import { SiteProjection, type RoomSql } from './projection';
import { countReads } from './read-count';
import type { RuntimeAgentEnv } from '../agent-runtime/env';

function roomSql(): RoomSql {
  const db = new DatabaseSync(':memory:');
  return { exec: <T>(sql: string, ...params: unknown[]) => {
    const statement = db.prepare(sql);
    return (/^\s*select/i.test(sql) ? statement.all(...params as never[]) : (statement.run(...params as never[]), [])) as T[];
  } };
}

it('builds every topic through the counting wrapper exactly as without it, and sums rows_read', async () => {
  const f = schemaTestDb();
  f.insert('sites', { id: 's', workspace_id: 'w', name: 'Site', ingest_url: 'https://example.invalid' });
  f.insert('leader_conversations', { id: 'c', workspace_id: 'w', site_id: 's', title: 'T', created_at: '2026-01-01' });
  f.insert('agent_tasks', { id: 't', workspace_id: 'w', site_id: 's', agent_id: 'topic_decision', agent_instance_id: 't', active_run_id: 'run-t', status: 'running', goal_json: '{}', created_at: '2026-01-01', updated_at: '2026-01-01' });
  // The shim reports no meta; give every read a fixed rows_read so the sum is observable.
  const metered = { ...f.db, prepare: (sql: string) => {
    const wrap = (statement: ReturnType<typeof f.db.prepare>): ReturnType<typeof f.db.prepare> => ({ ...statement,
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async () => ({ ...(await statement.all()), meta: { rows_read: 2 } }) }) as never;
    return wrap(f.db.prepare(sql));
  } } as typeof f.db;
  let rows = 0;
  const plain = new SiteProjection(roomSql(), { DB: f.db } as unknown as RuntimeAgentEnv, 's', 'v');
  const counted = new SiteProjection(roomSql(), { DB: countReads(metered, n => { rows += n; }) } as unknown as RuntimeAgentEnv, 's', 'v');
  for (const topic of ['team', 'activity', 'leader.list', 'leader.conv:c', 'panel:topic_decision', 'task:topic_decision:t']) {
    expect((await counted.subscribe(topic))?.data, topic).toEqual((await plain.subscribe(topic))?.data);
  }
  expect(rows).toBeGreaterThan(0);
  expect(rows % 2).toBe(0);
});
