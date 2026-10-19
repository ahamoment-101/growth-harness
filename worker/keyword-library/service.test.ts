// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { KeywordLibrary } from './service';
import { createKeywordLibraryTools } from './tools';
import { agentDefinition } from '../agent-runtime/definitions';
import { attachTask } from '../agent-runtime/task-store';
import { executionDatabase } from '../agent-runtime/execution-context';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution } from '../agent-runtime/runtime-executions';

const scope = { workspace_id: 'w', site_id: 's', locale: 'pt-BR' };
const actor = { type: 'human' as const, id: 'user-1' };
const op = (operation_id: string) => ({ operation_id, actor, reason: 'Test research update' });
function fixture() {
  const f = taskTestDb();
  f.sqlite.exec("alter table sites add column workspace_id text not null default 'w'; insert into sites values('other','other-w'); create table topics(id text primary key, site_id text, title_hint text, status text); insert into topics values('t1','s','First topic','queued'),('t2','s','Second topic','published'),('t3','other','Foreign','queued');");
  f.sqlite.exec("alter table topics add column plan_json text default '{}';");
  // @ts-ignore Test-only Node URL.
  f.sqlite.exec(readFileSync(new URL('../../migrations/0056_keyword_library.sql', import.meta.url), 'utf8'));
  f.sqlite.exec(readFileSync(new URL('../../migrations/0075_language_only_library.sql', import.meta.url).pathname, 'utf8'));
  f.sqlite.exec('pragma foreign_keys=on');
  const db = f.db as unknown as D1Database;
  return { ...f, db, library: new KeywordLibrary(db, scope) };
}

describe('independent keyword library', () => {
  it('creates without requiring research and replays exactly once; rejects changed operation input', async () => {
    const { library } = fixture();
    const first = await library.create('keyword', '  Email  ', {}, op('create'));
    expect(await library.create('keyword', 'Email', {}, op('create'))).toEqual(first);
    expect((await library.get(first.target_id)).data).toMatchObject({ priority: null, intents: [], metrics: [] });
    expect((await library.logs()).items).toHaveLength(1);
    await expect(library.create('keyword', 'Different', {}, op('create'))).rejects.toThrow('different input');
    await expect(library.create('keyword', 'email', {}, op('duplicate'))).rejects.toThrow('already exists');
    expect((await library.list()).items).toHaveLength(1);
  });
  it('isolates site, workspace, language', async () => {
    const { db, library } = fixture();
    const word = await library.create('keyword', 'email', {}, op('one'));
    for (const changed of [{ locale: 'en' }, { site_id: 'other' }, { workspace_id: 'other-w' }]) {
      const other = new KeywordLibrary(db, { ...scope, ...changed });
      await expect(other.get(word.target_id)).rejects.toThrow();
    }
    const portugal = new KeywordLibrary(db, { ...scope, locale: 'pt-PT' });
    await portugal.create('keyword', 'email', {}, op('one'));
    expect((await portugal.list()).items).toHaveLength(1);
    expect((await library.logs()).items).toHaveLength(1);
  });
  it('preserves omitted values, clears nullable fields and lists, logs exact human/AI diffs and protects logs', async () => {
    const { library, sqlite } = fixture();
    const entry = await library.create('keyword', 'email', { priority: 'high', intents: ['learn'], business_relevance: 'Useful' }, op('one'));
    const patch = { data: { intents: [], business_relevance: null } };
    const context = { operation_id: 'patch', actor: { type: 'agent' as const, id: 'researcher', run_id: 'r', task_id: 'task-r' }, reason: 'New evidence' };
    const receipt = await library.patch(entry.target_id, 1, patch, context);
    expect(await library.patch(entry.target_id, 1, patch, context)).toEqual(receipt);
    expect((await library.get(entry.target_id)).data).toMatchObject({ intents: [], business_relevance: null, priority: 'high' });
    const log = (await library.logs({ actor_type: 'agent' })).items[0];
    expect(log.changes).toContainEqual({ field: 'business_relevance', before: 'Useful', after: null });
    expect(log.actor.id).toBe('researcher');
    expect(() => sqlite.exec('delete from keyword_library_logs')).toThrow('immutable');
    expect(() => sqlite.exec("update keyword_library_logs set reason='changed'")).toThrow('immutable');
    await expect(library.patch('missing', 1, {}, op('missing'))).rejects.toThrow('not present');
  });
  it('allows only one concurrent revision and rolls back the losing log', async () => {
    const { library } = fixture();
    const entry = await library.create('keyword', 'email', {}, op('one'));
    const results = await Promise.allSettled([
      library.patch(entry.target_id, 1, { data: { priority: 'one' } }, op('a')),
      library.patch(entry.target_id, 1, { data: { priority: 'two' } }, op('b')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await library.get(entry.target_id)).revision).toBe(2);
    expect((await library.logs()).items).toHaveLength(2);
  });
  it('replays simultaneous creates under one operation without duplicate effects', async () => {
    const { library } = fixture();
    const result = await Promise.all([library.create('keyword', 'email', {}, op('same')), library.create('keyword', 'email', {}, op('same'))]);
    expect(result[0]).toEqual(result[1]);
    expect((await library.logs()).items).toHaveLength(1);
  });
  it('rejects unsupported fields and metrics without provenance', async () => {
    const { library } = fixture();
    await expect(library.create('keyword', 'email', { guessed_score: 1 }, op('bad'))).rejects.toThrow();
    await expect(library.create('keyword', 'email', { metrics: [{ name: 'volume', value: 1 }] }, op('bad-metric'))).rejects.toThrow();
    expect((await library.list()).items).toHaveLength(0);
  });
  it('maintains typed memberships, versions both ends, exposes child logs and forbids cross-market references', async () => {
    const { library, db } = fixture();
    const group = await library.create('topic_group', 'Business', {}, op('g'));
    const cluster = await library.create('cluster', 'Email writing', { need: 'Write emails' }, op('c'));
    const word = await library.create('keyword', 'email', {}, op('w'));
    await library.membership(group.target_id, cluster.target_id, true, op('gc'));
    await library.membership(cluster.target_id, word.target_id, true, op('cw'));
    expect((await library.get(word.target_id)).revision).toBe(2);
    expect((await library.list({ parent_id: cluster.target_id })).items[0].id).toBe(word.target_id);
    expect((await library.logs({ target_id: word.target_id })).items).toHaveLength(2);
    await expect(library.membership(word.target_id, group.target_id, true, op('invalid'))).rejects.toThrow('Expected');
    const other = await new KeywordLibrary(db, { ...scope, locale: 'pt-PT' }).create('keyword', 'email', {}, op('other'));
    await expect(library.membership(cluster.target_id, other.target_id, true, op('cross'))).rejects.toThrow('not present');
    await library.membership(cluster.target_id, word.target_id, false, op('remove'));
    expect((await library.detail(word.target_id)).memberships).toHaveLength(0);
  });
  it('supports many-to-many topic links and preserves them through archival', async () => {
    const { library } = fixture();
    const a = await library.create('keyword', 'email', {}, op('a'));
    const b = await library.create('keyword', 'formal email', {}, op('b'));
    await library.linkTopic(a.target_id, 't1', 'Primary need', op('a1'));
    await library.linkTopic(a.target_id, 't2', 'Reply angle', op('a2'));
    await library.linkTopic(b.target_id, 't1', 'Supporting need', op('b1'));
    expect((await library.detail(a.target_id)).topics).toHaveLength(2);
    await expect(library.linkTopic(a.target_id, 't3', 'Foreign', op('foreign'))).rejects.toThrow('this site');
    await library.patch(a.target_id, 3, { archived: true }, op('archive'));
    expect((await library.detail(a.target_id)).topics).toHaveLength(2);
    expect((await library.list()).items).toHaveLength(1);
    await library.linkTopic(a.target_id, 't2', null, op('unlink'));
    expect((await library.detail(a.target_id)).topics).toHaveLength(1);
  });
  it('rolls back entry changes when log insertion or later relation writes fail', async () => {
    const { library, sqlite } = fixture();
    const a = await library.create('keyword', 'email', {}, op('a'));
    sqlite.exec("CREATE TRIGGER fail_log BEFORE INSERT ON keyword_library_logs BEGIN SELECT RAISE(ABORT,'injected log failure'); END;");
    await expect(library.patch(a.target_id, 1, { name: 'new' }, op('patch'))).rejects.toThrow('injected');
    expect((await library.get(a.target_id)).revision).toBe(1);
    sqlite.exec("DROP TRIGGER fail_log; CREATE TRIGGER fail_link BEFORE INSERT ON keyword_library_topic_links BEGIN SELECT RAISE(ABORT,'injected link failure'); END;");
    await expect(library.linkTopic(a.target_id, 't1', 'link', op('link'))).rejects.toThrow('injected');
    expect((await library.get(a.target_id)).revision).toBe(1);
    expect((await library.logs()).items).toHaveLength(1);
  });
  it('paginates entries and logs without skipping records', async () => {
    const { library } = fixture();
    for (let i = 0; i < 5; i++) await library.create('keyword', `term ${i}`, { intents: ['learn'] }, op(`op-${i}`));
    const first = await library.list({ limit: 2, intent: 'learn' });
    const second = await library.list({ limit: 2, after: first.next });
    const third = await library.list({ limit: 2, after: second.next });
    expect(new Set([...first.items, ...second.items, ...third.items].map((e) => e.id)).size).toBe(5);
    expect(third.next).toBeNull();
    const logs = await library.logs({ limit: 3 });
    const remaining = await library.logs({ limit: 3, before: logs.next });
    expect(new Set([...logs.items, ...remaining.items].map((e) => e.id)).size).toBe(5);
  });
});

it('executes real tools using captured authority and observed versions; rejects stale executions atomically', async () => {
  const f = fixture();
  const task = await attachTask(f.db as never, f.run(), agentDefinition('strategy_research'));
  const execution = await createRuntimeExecution(f.db as never, task.active_run_id);
  const authority = authorityForExecution(execution);
  await activateRuntimeExecution(f.db as never, authority, execution.workflow_id);
  const scoped = executionDatabase(f.db as never, authority) as unknown as D1Database;
  const observed: Record<string, number> = {};
  const registry = createKeywordLibraryTools(async () => ({ db: scoped, scope, actor: { type: 'agent', id: 'research', run_id: task.active_run_id, task_id: task.id }, observed_revisions: observed }));
  const definition = { ...agentDefinition('strategy_research'), tools: registry.names() };
  const context = { workspaceId: 'w', siteId: 's', runId: task.active_run_id, idempotencyKey: 'tool-create', execution: authority };
  const created = await registry.execute(definition, 'create_library_keyword', { name: 'email', data: { priority: 'high' }, reason: 'research' }, context) as { target_id: string };
  const detail = await registry.execute(definition, 'read_library_entry', { reference: created.target_id }, context) as { entry: { revision: number } };
  observed[created.target_id] = detail.entry.revision;
  const logs = await registry.execute(definition, 'read_library_logs', {}, context) as { items: { actor: { run_id: string }; changes: unknown[] }[] };
  expect(logs.items[0].actor.run_id).toBe(task.active_run_id);
  expect(logs.items[0].changes.length).toBeGreaterThan(0);
  const input = { reference: created.target_id, data: { intents: ['learn'] }, reason: 'clarify' };
  await registry.execute(definition, 'revise_library_keyword', input, { ...context, idempotencyKey: 'revise' });
  expect((await f.library.get(created.target_id)).data.priority).toBe('high');
  await expect(registry.execute(definition, 'revise_library_keyword', { ...input, data: { priority: 'low' } }, { ...context, idempotencyKey: 'stale-observation' })).rejects.toThrow('revision');
  const next = await createRuntimeExecution(f.db as never, task.active_run_id, execution);
  await activateRuntimeExecution(f.db as never, authorityForExecution(next), next.workflow_id);
  await expect(registry.execute(definition, 'create_library_cluster', { name: 'late', data: {}, reason: 'late' }, { ...context, idempotencyKey: 'late' })).rejects.toThrow('authority lost');
  expect((await f.library.list()).items).toHaveLength(1);
  expect((await f.library.logs()).items).toHaveLength(2);
});

it('paginates topic detail and rejects invalid relationship scope in SQL itself', async () => {
  const { library, sqlite } = fixture();
  const word = await library.create('keyword', 'email', {}, op('word'));
  await library.linkTopic(word.target_id, 't1', 'First', op('first'));
  await library.linkTopic(word.target_id, 't2', 'Second', op('second'));
  const first = await library.detail(word.target_id, { limit: 1 });
  expect(first.topics).toHaveLength(1);
  const second = await library.detail(word.target_id, { limit: 1, topic_after: first.topic_next });
  expect(second.topics[0].topic_id).not.toBe(first.topics[0].topic_id);
  expect(second.topic_next).toBeNull();
  expect(() => sqlite.prepare("insert into keyword_library_topic_links(keyword_id,topic_id,workspace_id,site_id,locale,relationship) values(?,'t3','w','s','pt-BR','bad')").run(word.target_id)).toThrow('FOREIGN KEY');
  expect(sqlite.prepare('pragma foreign_key_check').all()).toEqual([]);
});

it('does not expose host identities in tools and refuses raw database writes', async () => {
  const f = fixture();
  const registry = createKeywordLibraryTools(async () => ({ db: f.db, scope, actor: { type: 'agent', id: 'agent', task_id: 'task', run_id: 'run' }, observed_revisions: {} }));
  const definition = { ...agentDefinition('strategy_research'), tools: registry.names() };
  const context = { workspaceId: 'w', siteId: 's', runId: 'run', idempotencyKey: 'create' };
  const tool = registry.resolve(definition, 'create_library_keyword');
  expect(tool.inputSchema.safeParse({ name: 'email', data: {}, reason: '', workspace_id: 'other' }).success).toBe(false);
  await expect(registry.execute(definition, 'create_library_keyword', { name: 'email', data: {}, reason: '' }, context)).rejects.toThrow('execution-scoped');
  expect((await f.library.logs()).items).toHaveLength(0);
});

it('rejects a scoped topic association from another language while allowing cleanup', async () => {
  const { library, sqlite } = fixture();
  const word = await library.create('keyword', 'email', {}, op('scope-word'));
  sqlite.prepare('update topics set plan_json=? where id=?').run(JSON.stringify({ locale: 'en' }), 't1');
  await expect(library.linkTopic(word.target_id, 't1', 'Same keyword', op('bad-link'))).rejects.toThrow('different language');
  expect((await library.logs()).items).toHaveLength(1);
});
