// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { appendEvidenceMemory, listAgentMemories } from './memory';

function memoryDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    create table agent_runs (id text primary key, status text, workspace_id text, site_id text, agent_id text, agent_instance_id text);
    create table agent_memories (
      id text primary key, workspace_id text, site_id text, agent_id text, kind text, version integer,
      content_json text, evidence_refs_json text, source_run_id text, supersedes_memory_id text, created_at text,
      unique (workspace_id, site_id, agent_id, kind, version), unique (source_run_id, kind)
    );
    insert into agent_runs values ('run-1', 'succeeded', 'workspace-1', 'site-1', 'runtime_synthetic', 'strategy:en');
    insert into agent_runs values ('run-pt', 'succeeded', 'workspace-1', 'site-1', 'runtime_synthetic', 'strategy:pt-BR');
  `);
  return {
    db: {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
          all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
          run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values as never[]).changes } }),
        }),
      }),
    } as unknown as D1Database,
    sqlite,
  };
}

describe('Agent evidence Memory', () => {
  it('replays one source Run and kind without creating a second version', async () => {
    const { db, sqlite } = memoryDb();
    const input = {
      workspaceId: 'workspace-1', siteId: 'site-1', agentId: 'runtime_synthetic', kind: 'verification',
      content: { learned: true }, evidenceRefs: ['agent_event:event-1'], sourceRunId: 'run-1',
    };
    const first = await appendEvidenceMemory(db, input);
    const replay = await appendEvidenceMemory(db, input);
    expect(replay.id).toBe(first.id);
    expect(sqlite.prepare('select count(*) as count from agent_memories').get()).toEqual({ count: 1 });
  });

  it('reads evidence memory only from the requested locale Agent instance', async () => {
    const { db, sqlite } = memoryDb();
    sqlite.exec(`
      insert into agent_memories values ('m-en', 'workspace-1', 'site-1', 'runtime_synthetic', 'finding', 1, '{}', '[]', 'run-1', '', '2026-09-01');
      insert into agent_memories values ('m-pt', 'workspace-1', 'site-1', 'runtime_synthetic', 'finding', 2, '{}', '[]', 'run-pt', '', '2026-09-02');
    `);
    const memories = await listAgentMemories(db, 'workspace-1', 'site-1', 'runtime_synthetic', 'strategy:pt-BR');
    expect(memories.map((item) => item.id)).toEqual(['m-pt']);
  });
});
