// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { assertAllowedGoogleIdentity, claimPrimaryWorkspace, userIdForGoogleSub } from './store';

const identity = {
  sub: 'google-subject-1',
  email: 'Owner@Example.com',
  emailVerified: true,
  name: 'Owner',
  picture: '',
};

function authDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    create table app_users (id text primary key, google_sub text unique, email text unique, display_name text, avatar_url text, created_at text, last_login_at text);
    create table workspaces (id text primary key, name text, owner_user_id text, created_at text);
    create table sites (id text primary key, workspace_id text not null, name text);
    insert into workspaces values ('primary-workspace', 'Primary Workspace', '', '2026-08-24T00:00:00.000Z');
    insert into sites values ('historical-site', 'primary-workspace', 'Historical');
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
  let queue = Promise.resolve<unknown>(undefined);
  const db = {
    prepare,
    batch: (statements: Array<{ run: () => Promise<unknown> }>) => {
      const transaction = queue.then(async () => {
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
      });
      queue = transaction.catch(() => undefined);
      return transaction;
    },
  } as unknown as D1Database;
  return { db, sqlite };
}

describe('application identity', () => {
  it('accepts only the configured verified Google account', () => {
    expect(() => assertAllowedGoogleIdentity(identity, 'owner@example.com')).not.toThrow();
    expect(() => assertAllowedGoogleIdentity({ ...identity, emailVerified: false }, identity.email)).toThrow(/not verified/);
    expect(() => assertAllowedGoogleIdentity(identity, 'other@example.com')).toThrow(/not allowed/);
    expect(() => assertAllowedGoogleIdentity(identity, '')).toThrow(/not configured/);
  });

  it('derives stable opaque user ids from Google subject', async () => {
    const first = await userIdForGoogleSub(identity.sub);
    expect(first).toBe(await userIdForGoogleSub(identity.sub));
    expect(first).not.toContain(identity.sub);
    expect(first).toMatch(/^google-[a-f0-9]{32}$/);
  });

  it('atomically claims one Workspace and preserves historical sites across concurrent first login and replay', async () => {
    const { db, sqlite } = authDb();
    const [first, concurrent] = await Promise.all([
      claimPrimaryWorkspace(db, identity, 'owner@example.com'),
      claimPrimaryWorkspace(db, identity, 'owner@example.com'),
    ]);
    const replay = await claimPrimaryWorkspace(db, identity, 'owner@example.com');
    expect(first.workspace.id).toBe('primary-workspace');
    expect(concurrent.user.id).toBe(first.user.id);
    expect(replay.user.id).toBe(first.user.id);
    expect(sqlite.prepare('select count(*) as count from app_users').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('select count(*) as count from workspaces').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('select id, workspace_id from sites').all()).toEqual([
      { id: 'historical-site', workspace_id: 'primary-workspace' },
    ]);
  });
});
