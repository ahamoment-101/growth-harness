// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  WORKING_DRAFT_MAX_BYTES,
  closeWorkingDraft,
  listWorkingDrafts,
  readWorkingDraft,
  writeWorkingDraft,
} from './working-draft';

function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    create table agent_working_drafts (
      id text primary key,
      workspace_id text not null,
      site_id text not null,
      agent_id text not null,
      agent_instance_id text not null default '',
      lineage_id text not null,
      version integer not null default 0,
      status text not null default 'drafting',
      content_json text not null,
      byte_length integer not null default 0,
      last_write_key text not null default '',
      last_run_id text not null default '',
      created_at text not null,
      updated_at text not null,
      unique (workspace_id, site_id, agent_id, agent_instance_id, lineage_id)
    );
  `);
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    return {
      bind: (...next: unknown[]) => {
        values = next;
        return {
          first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
          all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
          run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values as never[]).changes } }),
        };
      },
    };
  };
  return { db: { prepare } as never };
}

const ja = {
  workspaceId: 'w1', siteId: 's1', agentId: 'strategy_research',
  instanceId: 'strategy:ja-JP', lineageId: 'root-1',
};
const en = { ...ja, instanceId: 'strategy:en-US' };

describe('working draft', () => {
  it('keeps a draft across the Runs of one lineage', async () => {
    // The whole point: a successor Run picks the work up instead of restarting.
    const { db } = sqliteD1();
    await writeWorkingDraft(db, { identity: ja, writeKey: 'run-1:blueprint', runId: 'run-1', content: { clusters: 2 } });
    const seen = await readWorkingDraft<{ clusters: number }>(db, ja);
    expect(seen?.content.clusters).toBe(2);
    expect(seen?.lastRunId).toBe('run-1');

    await writeWorkingDraft(db, { identity: ja, writeKey: 'run-2:keywords', runId: 'run-2', content: { clusters: 2, keywords: 6 } });
    const resumed = await readWorkingDraft<{ clusters: number; keywords: number }>(db, ja);
    expect(resumed?.content).toEqual({ clusters: 2, keywords: 6 });
    expect(resumed?.version).toBe(2);
  });

  it('treats a repeated write key as the same edit', async () => {
    // A durable step that ran but never recorded its result runs again. Without
    // this, the replay appends a second version of the same edit.
    const { db } = sqliteD1();
    await writeWorkingDraft(db, { identity: ja, writeKey: 'run-1:blueprint', runId: 'run-1', content: { v: 1 } });
    const replayed = await writeWorkingDraft(db, { identity: ja, writeKey: 'run-1:blueprint', runId: 'run-1', content: { v: 1 } });
    expect(replayed.version).toBe(1);
    expect((await readWorkingDraft<{ v: number }>(db, ja))?.version).toBe(1);
  });

  it('lets a successor Run redo a stage its predecessor already wrote', async () => {
    // Write keys are Run-scoped, so a deliberate redo is never mistaken for a
    // replay of the previous Run's write.
    const { db } = sqliteD1();
    await writeWorkingDraft(db, { identity: ja, writeKey: 'run-1:blueprint', runId: 'run-1', content: { v: 1 } });
    const redone = await writeWorkingDraft(db, { identity: ja, writeKey: 'run-2:blueprint', runId: 'run-2', content: { v: 2 } });
    expect(redone.version).toBe(2);
    expect(redone.content).toEqual({ v: 2 });
  });

  it('never serves one locale the draft of another', async () => {
    // Each language is an independent market strategy; isolation is enforced in
    // the query, not checked after the fetch.
    const { db } = sqliteD1();
    await writeWorkingDraft(db, { identity: ja, writeKey: 'run-1:a', runId: 'run-1', content: { locale: 'ja' } });
    expect(await readWorkingDraft(db, en)).toBeNull();
    expect(await readWorkingDraft(db, { ...ja, siteId: 's2' })).toBeNull();
    expect(await readWorkingDraft(db, { ...ja, workspaceId: 'w2' })).toBeNull();
    expect(await readWorkingDraft(db, { ...ja, lineageId: 'root-2' })).toBeNull();
    expect(await readWorkingDraft(db, { ...ja, agentId: 'article_production' })).toBeNull();
  });

  it('gives a genuinely new task a clean sheet', async () => {
    // A new research task gets a new root Run, so it must not inherit the half
    // finished strategy of the previous one.
    const { db } = sqliteD1();
    await writeWorkingDraft(db, { identity: ja, writeKey: 'run-1:a', runId: 'run-1', content: { old: true } });
    expect(await readWorkingDraft(db, { ...ja, lineageId: 'root-2' })).toBeNull();
  });

  it('refuses an oversized draft instead of shortening it', async () => {
    // Silently truncating the artifact an Agent is building is how work
    // disappears with nobody noticing.
    const { db } = sqliteD1();
    await expect(writeWorkingDraft(db, {
      identity: ja, writeKey: 'run-1:a', runId: 'run-1', content: { blob: 'x'.repeat(WORKING_DRAFT_MAX_BYTES + 100) },
    })).rejects.toThrow(/byte limit/);
  });

  it('redacts secrets that reach a draft', async () => {
    const { db } = sqliteD1();
    await writeWorkingDraft(db, {
      identity: ja, writeKey: 'run-1:a', runId: 'run-1',
      content: { authorization: 'Bearer abc123', note: 'Bearer xyz789' },
    });
    expect(JSON.stringify((await readWorkingDraft(db, ja))?.content)).not.toContain('abc123');
    expect(JSON.stringify((await readWorkingDraft(db, ja))?.content)).not.toContain('xyz789');
  });

  it('keeps a submitted draft rather than deleting it', async () => {
    // After submit, the draft is the record of how the artifact was built —
    // the one question the finished artifact cannot answer.
    const { db } = sqliteD1();
    await writeWorkingDraft(db, { identity: ja, writeKey: 'run-1:a', runId: 'run-1', content: { done: true } });
    await closeWorkingDraft(db, ja, 'submitted');
    const closed = await readWorkingDraft(db, ja);
    expect(closed?.status).toBe('submitted');
    expect(closed?.content).toEqual({ done: true });
  });

  it('lists a site’s drafts as stored, without reshaping them', async () => {
    const { db } = sqliteD1();
    await writeWorkingDraft(db, { identity: ja, writeKey: 'run-1:a', runId: 'run-1', content: { locale: 'ja' } });
    await writeWorkingDraft(db, { identity: en, writeKey: 'run-1:b', runId: 'run-1', content: { locale: 'en' } });
    const drafts = await listWorkingDrafts(db, { workspaceId: 'w1', siteId: 's1', agentId: 'strategy_research' });
    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.instanceId).sort()).toEqual(['strategy:en-US', 'strategy:ja-JP']);
    expect(drafts.every((draft) => typeof draft.content === 'object')).toBe(true);
  });

  it('rejects an incomplete identity rather than writing an unreachable draft', async () => {
    const { db } = sqliteD1();
    await expect(writeWorkingDraft(db, {
      identity: { ...ja, lineageId: '' }, writeKey: 'k', runId: 'r', content: {},
    })).rejects.toThrow(/identity is incomplete/);
    await expect(writeWorkingDraft(db, {
      identity: ja, writeKey: '  ', runId: 'r', content: {},
    })).rejects.toThrow(/write key/);
  });
});
