import { describe, expect, it, vi } from 'vitest';
// @ts-ignore Node-only migration acceptance.
import { DatabaseSync } from 'node:sqlite';
// @ts-ignore Node-only migration acceptance.
import { readFileSync } from 'node:fs';
import type { D1PreparedStatement, VectorizeVector } from '@cloudflare/workers-types';
import { schemaTestDb } from '../lib/schema-test-db';
import { ToolRegistry } from '../agent-runtime/tools';
import { agentDefinition } from '../agent-runtime/definitions';
import type { AgentTask } from '../agent-runtime/task-store';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { addBusinessLearningTools, businessLearningToolNames } from './business';
import { learningTools } from './agent';
import { createPractice, commitRecords, requireRecord, recordView, emptyLearning } from './store';
import { EMBEDDING_DIMENSIONS, embedLearningText, learningSearchCoverage, processLearningSearch, searchLearning, type LearningSearchBindings } from './search';

const scope = { workspaceId: 'primary-workspace', siteId: 'search-site' };
const at = new Date('2040-01-01T00:00:00Z');
const later = (seconds: number) => new Date(at.getTime() + seconds * 1000);
function fixture() {
  const f = schemaTestDb();
  f.db.batch = (async (statements: D1PreparedStatement[]) => {
    f.sqlite.exec('begin');
    try { const out = []; for (const s of statements) out.push(await s.run()); f.sqlite.exec('commit'); return out; }
    catch (e) { f.sqlite.exec('rollback'); throw e; }
  }) as typeof f.db.batch;
  const vectors = new Map<string, VectorizeVector>();
  const run = vi.fn(async (): Promise<{ data: number[][] }> => ({ data: [Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0)] }));
  const upsert = vi.fn(async (rows: VectorizeVector[]) => {
    for (const row of rows) vectors.set(row.id, row);
    return { mutationId: crypto.randomUUID() };
  });
  const getByIds = vi.fn(async (ids: string[]) => ids.flatMap((id) => vectors.has(id) ? [vectors.get(id)!] : []));
  const query = vi.fn(async (_vector: unknown, options?: { namespace?: string; topK?: number }) => {
    const matches = [...vectors.values()].filter((v) => v.namespace === options?.namespace)
      .slice(0, options?.topK).map((v) => ({ ...v, score: 0.7 }));
    return { matches, count: matches.length };
  });
  const deleteByIds = vi.fn(async (ids: string[]) => { for (const id of ids) vectors.delete(id); return { mutationId: crypto.randomUUID() }; });
  const env = { DB: f.db, AI: { run }, LEARNING_VECTOR_INDEX: { upsert, query, getByIds, deleteByIds } } as unknown as RuntimeAgentEnv;
  const create = (id = 'lesson', owned = scope) => createPractice(f.db, owned, id, 'growth_leader', 'A concrete reader need', { id, material: {} });
  const revise = async (id: string, edit: (data: ReturnType<typeof recordView>) => void) => {
    const previous = await requireRecord(f.db, scope, id), data = recordView(previous);
    edit(data);
    await commitRecords(f.db, scope, crypto.randomUUID(), {}, [{ previous, data }]);
  };
  const ready = async () => { await processLearningSearch(env, at, 50); await processLearningSearch(env, later(6), 50); };
  return { ...f, env, vectors, run, upsert, getByIds, query, deleteByIds, create, revise, ready };
}

describe('durable semantic experience index', () => {
  it('backfills existing records once without rewriting their business data', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('create table learning_records(id text primary key,workspace_id text,site_id text,title text,data_json text);');
    const data = JSON.stringify(emptyLearning('Historical claim'));
    db.prepare('insert into learning_records values(?,?,?,?,?)').run('old', 'w', 's', 'Historical title', data);
    db.exec(readFileSync(new URL('../../migrations/0084_learning_search.sql', import.meta.url).pathname, 'utf8'));
    expect(db.prepare('select record_id,generation,state from learning_search_jobs').all()).toEqual([{ record_id: 'old', generation: 1, state: 'pending' }]);
    expect(db.prepare('select data_json from learning_records').get()).toEqual({ data_json: data });
    db.close();
  });
  it('atomically creates index work, confirms visibility and hydrates latest D1 utility without re-embedding it', async () => {
    const f = fixture(); await f.create();
    expect(await learningSearchCoverage(f.db, scope)).toMatchObject({ total: 1, ready: 0 });
    await processLearningSearch(f.env, at);
    expect(await learningSearchCoverage(f.db, scope)).toMatchObject({ ready: 0, pending: 1 });
    await processLearningSearch(f.env, later(6));
    await f.revise('lesson', (data) => { data.utility = { score: 0.8, feedback_count: 3, calculation_version: 'ema-0.2-v1' }; });
    await processLearningSearch(f.env, later(7));
    expect(f.run).toHaveBeenCalledTimes(1);
    const result = await searchLearning(f.env, scope, 'Different words for the same business goal');
    expect(result.records[0]).toMatchObject({ id: 'lesson', version: 1, utility: { score: 0.8, feedback_count: 3 } });
    expect(result.coverage.complete).toBe(true);
    expect(f.sqlite.prepare('select count(*) n from learning_uses').get()).toEqual({ n: 0 });
  });

  it('rolls back both experience revisions and index work on an atomic conflict', async () => {
    const f = fixture(); const row = await f.create();
    const data = recordView(row); data.experience.insight = 'A changed judgment';
    await expect(commitRecords(f.db, scope, 'bad', {}, [{ previous: row, data }], [
      f.db.prepare('insert into learning_records(id) values(?)').bind('bad'),
    ])).rejects.toThrow();
    expect((await requireRecord(f.db, scope, row.id)).version).toBe(0);
    expect(f.sqlite.prepare('select count(*) n from learning_search_jobs').get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare('select count(*) n from learning_operations').get()).toEqual({ n: 0 });
  });

  it('recovers an unknown upsert response by reading its stable identity, without a second embedding', async () => {
    const f = fixture(); await f.create();
    f.upsert.mockImplementationOnce(async (rows) => { for (const row of rows) f.vectors.set(row.id, row); throw new Error('Lost receipt'); });
    await processLearningSearch(f.env, at);
    expect(await learningSearchCoverage(f.db, scope)).toMatchObject({ errors: 1, ready: 0 });
    await processLearningSearch({ ...f.env }, later(6));
    expect(await learningSearchCoverage(f.db, scope)).toMatchObject({ errors: 0, ready: 1 });
    expect(f.upsert).toHaveBeenCalledTimes(1);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it('waits for an acknowledged asynchronous mutation without re-embedding or re-upserting', async () => {
    const f = fixture(); await f.create();
    f.getByIds.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await processLearningSearch(f.env, at); await processLearningSearch(f.env, later(6));
    expect(await learningSearchCoverage(f.db, scope)).toMatchObject({ ready: 0 });
    await processLearningSearch(f.env, later(12));
    expect(await learningSearchCoverage(f.db, scope)).toMatchObject({ ready: 1 });
    expect(f.upsert).toHaveBeenCalledTimes(1);
  });

  it('claims jobs once under concurrent cron executions and recovers an expired persisted lease', async () => {
    const f = fixture(); await f.create();
    await Promise.all([processLearningSearch(f.env, at), processLearningSearch(f.env, at)]);
    expect(f.upsert).toHaveBeenCalledTimes(1);
    f.sqlite.prepare("update learning_search_jobs set lease_until=?,lease_token='crashed'").run(later(120).toISOString());
    await processLearningSearch(f.env, later(60));
    expect(await learningSearchCoverage(f.db, scope)).toMatchObject({ ready: 0 });
    await processLearningSearch(f.env, later(121));
    expect(await learningSearchCoverage(f.db, scope)).toMatchObject({ ready: 1 });
  });

  it('rejects old semantic generations even when stale vectors remain visible, then indexes the revision', async () => {
    const f = fixture(); await f.create(); await f.ready();
    const old = [...f.vectors.values()][0];
    await f.revise('lesson', (data) => { data.experience.insight = 'The earlier claim failed; target the concrete reader scenario.'; });
    const stale = await searchLearning(f.env, scope, 'Reader needs');
    expect(stale.records).toHaveLength(0); expect(stale.discarded).toBe(1);
    expect(stale.coverage.complete).toBe(false);
    await f.ready();
    const current = [...f.vectors.values()][0];
    expect(current.id).not.toBe(old.id);
    f.vectors.set(old.id, old); // A delayed provider response cannot overwrite the newer generation.
    const result = await searchLearning(f.env, scope, 'Reader needs');
    expect(result.records).toHaveLength(1);
    expect(result.records[0].experience.insight).toContain('earlier claim failed');
  });

  it('enforces namespace on the query and D1 scope again on hydration, including malicious cross-site matches', async () => {
    const f = fixture(); await f.create();
    await f.create('other-site', { ...scope, siteId: 'other' });
    await f.create('other-workspace', { ...scope, workspaceId: 'foreign' }); await f.ready();
    const result = await searchLearning(f.env, scope, 'Reader need');
    expect(result.records.map((r) => r.id)).toEqual(['lesson']);
    f.query.mockResolvedValueOnce({ count: 3, matches: [...f.vectors.values()].map((v) => ({ ...v, score: 1 })) });
    const poisoned = await searchLearning(f.env, scope, 'Reader need');
    expect(poisoned.records.map((r) => r.id)).toEqual(['lesson']); expect(poisoned.discarded).toBe(2);
  });

  it('excludes foreign embedding profiles and corrupt metadata; similarity is never used as utility', async () => {
    const f = fixture(); await f.create(); await f.ready();
    const vector = [...f.vectors.values()][0];
    f.query.mockResolvedValueOnce({ count: 1, matches: [{ ...vector, metadata: { ...vector.metadata, profile: 'wrong' }, score: 1 }] });
    expect((await searchLearning(f.env, scope, 'Intent')).records).toHaveLength(0);
    expect((await searchLearning(f.env, scope, 'Intent')).records[0].utility.score).toBeNull();
  });

  it('retains failed indexing and makes missing configuration or provider failure explicit', async () => {
    const f = fixture(); await f.create();
    expect(await processLearningSearch({ DB: f.db }, at)).toMatchObject({ status: 'configuration_missing' });
    expect(await searchLearning({ DB: f.db }, scope, 'Intent')).toMatchObject({ status: 'configuration_missing', coverage: { pending: 1 } });
    f.run.mockRejectedValueOnce(new Error('Provider unavailable'));
    await processLearningSearch(f.env, at);
    expect(await learningSearchCoverage(f.db, scope)).toMatchObject({ errors: 1 });
    f.query.mockRejectedValueOnce(new Error('Provider unavailable'));
    expect(await searchLearning(f.env, scope, 'Intent')).toMatchObject({ status: 'temporarily_unavailable' });
    await processLearningSearch(f.env, later(6)); await processLearningSearch(f.env, later(12));
    expect(await learningSearchCoverage(f.db, scope)).toMatchObject({ ready: 1, errors: 0 });
  });

  it('never silently accepts invalid vector dimensions or nonfinite values', async () => {
    for (const values of [[1, 2], Array(1024).fill(NaN), Array(1024).fill(0)]) {
      const env = { AI: { run: async () => ({ data: [values] }) } } as unknown as LearningSearchBindings;
      await expect(embedLearningText(env, 'Intent')).rejects.toThrow('invalid shape');
    }
  });

  it('retains an explicit protocol failure without blindly repeating a paid malformed embedding', async () => {
    const f = fixture(); await f.create();
    f.run.mockResolvedValueOnce({ data: [[1, 2]] });
    await processLearningSearch(f.env, at);
    expect(await learningSearchCoverage(f.db, scope)).toMatchObject({ blocked: 1, errors: 1, complete: false });
    await processLearningSearch(f.env, later(600));
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.upsert).not.toHaveBeenCalled();
  });

  it('uses the due index and scoped directory, including history older than the first page', async () => {
    const f = fixture();
    for (let i = 0; i < 26; i++) f.insert('learning_records', { id: `old-${i}`, workspace_id: scope.workspaceId, site_id: scope.siteId,
      origin_task_id: `origin-${i}`, title: `Experience ${i}`, status: 'evaluated', data_json: JSON.stringify(emptyLearning('Reader needs')),
      created_at: '2020-01-01T00:00:00.000Z', updated_at: `2020-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` });
    const task = { agent_id: 'growth_leader', definition_version: 21, workspace_id: scope.workspaceId, site_id: scope.siteId } as AgentTask;
    const registry = addBusinessLearningTools(new ToolRegistry(), f.env, task);
    const definition = { ...agentDefinition('growth_leader'), tools: businessLearningToolNames(task) };
    const tool = registry.resolve(definition, 'list_business_experience');
    const first = await tool.execute!({ query: '', cursor: '' }, {} as never) as { records: unknown[]; next_cursor: string };
    const second = await tool.execute!({ query: '', cursor: first.next_cursor }, {} as never) as { records: unknown[]; next_cursor: string };
    expect(first.records).toHaveLength(20); expect(second.records).toHaveLength(6); expect(second.next_cursor).toBeNull();
    const plan = f.sqlite.prepare("explain query plan select * from learning_search_jobs where state in ('pending','confirming','retiring') and available_at<=? and lease_until<=? order by available_at,record_id,generation limit 10").all(at.toISOString(), at.toISOString());
    expect(JSON.stringify(plan)).toContain('learning_search_jobs_due');
    await f.ready();
    await searchLearning(f.env, scope, 'Reader needs');
    const hydration = [...f.seen].find((sql) => sql.startsWith('select r.*,j.vector_id'))!;
    const hydrationPlan = f.sqlite.prepare('explain query plan ' + hydration).all(...Array((hydration.match(/\?/g) || []).length).fill('x'));
    expect(JSON.stringify(hydrationPlan)).toContain('SEARCH j USING INDEX learning_search_jobs_vector (vector_id=?)');
  });

  it('keeps historical tool contracts pinned and grants semantic search only to new Leader and Learning versions', () => {
    const f = fixture();
    for (const version of [20, 21]) {
      const task = { agent_id: 'growth_leader', definition_version: version, workspace_id: scope.workspaceId, site_id: scope.siteId } as AgentTask;
      const tools = addBusinessLearningTools(new ToolRegistry(), f.env, task);
      const definition = { ...agentDefinition('growth_leader'), tools: businessLearningToolNames(task) };
      expect(tools.resolve(definition, 'find_business_experience').version).toBe(version === 21 ? 2 : 1);
      expect(tools.names().includes('list_business_experience')).toBe(version === 21);
    }
    for (const version of [1, 2]) {
      const tools = learningTools(f.env, { definition_version: version } as AgentTask);
      expect(tools.resolve(agentDefinition('learning_agent'), 'search_learning_history').version).toBe(version);
      expect(tools.names().includes('list_learning_history')).toBe(version === 2);
    }
  });
});
