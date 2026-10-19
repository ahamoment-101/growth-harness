// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { getJobForWorkspace, getSiteForWorkspace, getTopicForWorkspace } from './db';

function workspaceDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    create table sites (id text primary key, workspace_id text not null, name text not null);
    create table jobs (id text primary key, site_id text not null, status text not null);
    create table topics (id text primary key, site_id text not null, status text not null);
    insert into sites values ('site-a', 'workspace-a', 'A'), ('site-b', 'workspace-b', 'B');
    insert into jobs values ('job-a', 'site-a', 'queued'), ('job-b', 'site-b', 'queued');
    insert into topics values ('topic-a', 'site-a', 'queued'), ('topic-b', 'site-b', 'queued');
  `);
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
      }),
    }),
  } as unknown as D1Database;
}

describe('Workspace-scoped persistence accessors', () => {
  it('does not reveal a site, job, or topic owned by another Workspace', async () => {
    const db = workspaceDb();
    await expect(getSiteForWorkspace(db, 'workspace-a', 'site-a')).resolves.toMatchObject({ id: 'site-a' });
    await expect(getSiteForWorkspace(db, 'workspace-a', 'site-b')).resolves.toBeNull();
    await expect(getJobForWorkspace(db, 'workspace-a', 'job-b')).resolves.toBeNull();
    await expect(getTopicForWorkspace(db, 'workspace-a', 'site-a', 'topic-b')).resolves.toBeNull();
  });
});
