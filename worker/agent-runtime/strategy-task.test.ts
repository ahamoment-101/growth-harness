import { describe, expect, it } from 'vitest';
import { taskTestDb } from './task-test-db';
import { attachTask, beginTaskDecision, finishTaskOperation, requireTask, setTaskAction } from './task-store';
import { agentDefinition } from './definitions';
import { strategyTaskTools, strategyWorkspace, strategyBusinessSnapshot } from './strategy-task';
import type { StrategyBlueprint, StrategyKeyword } from '../lib/research/ingest';
import type { RuntimeAgentEnv } from './env';
const definition = agentDefinition('strategy_research');
const blueprint: StrategyBlueprint = {
  change_summary: 'fixture', research_scope_summary: 'en', executive_strategy: 'Evidence-based', search_landscape: 'Unknown', selected_playbooks: 'Guides',
  site_architecture: '/guides', internal_linking: 'Link related guides', roadmap: 'Validate demand', measurement: 'Qualified visits', risks_unknowns: 'Unproven demand', evidence_notes: 'Fixture',
  territories: [{ key: 't', name: 'Guides', priority_band: 'high', status: 'active', audience_summary: 'Readers', search_job_summary: 'Learn', business_goal: 'Understand product', conversion_goal: 'Trial', summary: 'Guides' }],
  clusters: [{ key: 'c', territory_key: 't', name: 'Learning', priority_band: 'high', status: 'active', strategic_role: 'Education', recommended_hub: '/guides', conversion_goal: 'Trial', summary: 'Learning' }],
};
function keyword(term: string): StrategyKeyword {
  return { term, locale: 'en', cluster_key: 'c', intent: 'informational', journey_stage: 'problem', serp_shape: 'guides', recommended_page_type: 'guide', business_relevance: 'Unknown', conversion_route: 'Trial', priority_band: 'medium', priority_rationale: 'Needs evidence', coverage_status: 'uncovered', decision: 'watch', existing_url: '', evidence_summary: 'Unverified', source_urls: [] };
}
async function fixture() {
  const { db, run } = taskTestDb(); const execution = run(); await attachTask(db, execution, definition);
  // Keyword lists are a pinned pre-v34 contract; later tasks delegate keywords to the library.
  await db.prepare('update agent_tasks set parameter_contract_version=0,definition_version=33 where id=?').bind(execution.id).run();
  async function execute(name: string, args: Record<string, unknown>) {
    const task = await requireTask(db, execution.id);
    const operation = await beginTaskDecision(db, task, {});
    await setTaskAction(db, task, operation, { name, input: args });
    const registry = strategyTaskTools({ env: { DB: db } as RuntimeAgentEnv, definition, runId: execution.id, task, operation, locale: 'en' });
    try {
      const result = await registry.execute(definition, name, { judgment_summary: 'Fixture action', ...args }, { runId: execution.id, siteId: task.site_id, workspaceId: task.workspace_id, idempotencyKey: operation.id });
      await finishTaskOperation(db, task, operation, result); return result;
    } catch (error) {
      await finishTaskOperation(db, task, operation, {}, String(error)); throw error;
    }
  }
  return { db, execution, execute };
}
describe('production strategy workspace tools', () => {
  it('revises one keyword without deleting its sibling keyword', async () => {
    const { db, execution, execute } = await fixture();
    await execute('create_strategy_blueprint', { expected_revision: 0, blueprint });
    await execute('update_strategy_keywords', { expected_revision: 1, keywords: [keyword('US'), keyword('GB')], remove_keywords: [] });
    await execute('update_strategy_keywords', { expected_revision: 2, keywords: [], remove_keywords: [{ term: 'US' }] });
    expect(strategyWorkspace(await requireTask(db, execution.id)).keywords.map((item) => item.term)).toEqual(['GB']);
  });
  it('preserves saved work when a revision removes referenced clusters or uses another locale', async () => {
    const { db, execution, execute } = await fixture();
    await execute('create_strategy_blueprint', { expected_revision: 0, blueprint });
    await execute('update_strategy_keywords', { expected_revision: 1, keywords: [keyword('US')], remove_keywords: [] });
    await expect(execute('patch_strategy_blueprint', { expected_revision: 2, blueprint: { ...blueprint, clusters: [] } })).rejects.toThrow('cluster reference');
    await expect(execute('update_strategy_keywords', { expected_revision: 2, keywords: [{ ...keyword('US'), locale: 'ja' }], remove_keywords: [] })).rejects.toThrow('locale');
    expect(strategyWorkspace(await requireTask(db, execution.id)).keywords).toHaveLength(1);
    expect((await requireTask(db, execution.id)).revision).toBe(2);
  });
  it('patches blueprint prose while preserving relationships and rejects null without changing saved work', async () => {
    const { db, execution, execute } = await fixture();
    await execute('create_strategy_blueprint', { expected_revision: 0, blueprint });
    await execute('patch_strategy_blueprint', { expected_revision: 1, blueprint: { executive_strategy: 'Revised direction' } });
    expect(strategyWorkspace(await requireTask(db, execution.id)).blueprint).toEqual({ ...blueprint, executive_strategy: 'Revised direction' });
    await expect(execute('patch_strategy_blueprint', { expected_revision: 2, blueprint: { executive_strategy: null } })).rejects.toThrow();
    expect((await requireTask(db, execution.id)).revision).toBe(2);
  });
  it('reads a complete workspace through bounded pages and keeps business version provenance', async () => {
    const { execute } = await fixture();
    await execute('create_strategy_blueprint', { expected_revision: 0, blueprint: { ...blueprint, executive_strategy: 'a'.repeat(24000) } });
    const first = await execute('read_strategy_workspace', { offset: 0 }) as { excerpt: string; next_offset: number };
    const second = await execute('read_strategy_workspace', { offset: first.next_offset }) as { excerpt: string; next_offset: null };
    expect(JSON.parse(first.excerpt + second.excerpt).blueprint.executive_strategy).toHaveLength(24000);
    expect(second.next_offset).toBeNull();
    expect(strategyBusinessSnapshot({ context_json: JSON.stringify({ prompt: JSON.stringify({ sources: [{ sourceId: 'business_modules', version: 'product:2|audience:3|proof:0' }] }) }) } as never)).toEqual({ product: 2, audience: 3 });
  });
});

describe('keyword patch contract', () => {
  it('preserves omitted facts, clears explicit arrays, and rejects incomplete creates atomically', async () => {
    const { db, execution, execute } = await fixture();
    await execute('create_strategy_blueprint', { expected_revision: 0, blueprint });
    const original = { ...keyword('US'), source_urls: ['https://example.com/evidence'] };
    await execute('update_strategy_keywords', { expected_revision: 1, keywords: [original], remove_keywords: [] });
    await execute('update_strategy_keywords', { expected_revision: 2, keywords: [{ term: original.term, source_urls: [] }], remove_keywords: [] });
    expect(strategyWorkspace(await requireTask(db, execution.id)).keywords).toEqual([{ ...original, source_urls: [] }]);
    await expect(execute('update_strategy_keywords', { expected_revision: 3, keywords: [{ term: original.term, business_relevance: 'Changed' }, { term: 'new' }], remove_keywords: [] })).rejects.toThrow('Incomplete keyword');
    expect(strategyWorkspace(await requireTask(db, execution.id)).keywords[0].business_relevance).toBe(original.business_relevance);
  });

  it('rejects contradictory mutations without changing the workspace', async () => {
    const { db, execution, execute } = await fixture();
    await execute('create_strategy_blueprint', { expected_revision: 0, blueprint });
    await expect(execute('update_strategy_keywords', { expected_revision: 1, keywords: [keyword('US')], remove_keywords: [{ term: 'US' }] })).rejects.toThrow('Conflicting keyword');
    expect(strategyWorkspace(await requireTask(db, execution.id)).keywords).toEqual([]);
  });
});

it('identifies only unsupported references and preserves the saved keyword', async () => {
  const { db, execution, execute } = await fixture();
  const valid = 'https://example.com/valid';
  const invalid = 'https://example.com/unsupported';
  const task = await requireTask(db, execution.id);
  const search = await beginTaskDecision(db, task, {});
  await setTaskAction(db, task, search, { name: 'strategy_search_web', input: { queries: ['fixture'] } });
  await finishTaskOperation(db, task, search, [{ url: valid, title: 'Source', content: 'Evidence', query: 'fixture' }]);
  await execute('create_strategy_blueprint', { expected_revision: 0, blueprint });
  await execute('update_strategy_keywords', { expected_revision: 1, keywords: [{ ...keyword('US'), source_urls: [valid, invalid] }], remove_keywords: [] });
  try {
    await execute('submit_strategy', { expected_revision: 2 });
    throw new Error('Expected invalid citation rejection');
  } catch (error) {
    expect(error).toMatchObject({ details: { kind: 'invalid_request', effects: 'none', issues: [{ path: ['keywords', 0, 'source_urls', 1], message: expect.stringContaining(invalid) }] } });
  }
  expect(strategyWorkspace(await requireTask(db, execution.id)).keywords[0].source_urls).toEqual([valid, invalid]);
});

it('separates creation from patching without changing complete blueprint validation', async () => {
  const { execute } = await fixture();
  await expect(execute('patch_strategy_blueprint', { expected_revision: 0, blueprint: { roadmap: 'Next' } })).rejects.toThrow('does not exist');
  const { roadmap: _roadmap, evidence_notes: _evidence, ...incomplete } = blueprint;
  await expect(execute('create_strategy_blueprint', { expected_revision: 0, blueprint: incomplete })).rejects.toThrow();
  await execute('create_strategy_blueprint', { expected_revision: 0, blueprint });
  await expect(execute('create_strategy_blueprint', { expected_revision: 1, blueprint })).rejects.toThrow('already exists');
  await execute('patch_strategy_blueprint', { expected_revision: 1, blueprint: { roadmap: 'Next' } });
});


describe('manual next-version completion contract', () => {
  it('rejects no-change completion before effects while preserving the working draft', async () => {
    const { db, execution, execute } = await fixture();
    await execute('create_strategy_blueprint', { expected_revision: 0, blueprint });
    await expect(execute('finish_strategy', { outcome: 'no_change', reason: 'Still applicable', resume_when: '' })).rejects.toThrow();
    const task = await requireTask(db, execution.id);
    expect(task.status).toBe('running');
    expect(strategyWorkspace(task).blueprint).toEqual(blueprint);
  });

  it('lets a v38 request finish without a new version but not claim no_change after submitting one', async () => {
    const { db, execution } = await fixture();
    const task = { ...await requireTask(db, execution.id), definition_version: 38 };
    const tool = strategyTaskTools({ env: { DB: db } as RuntimeAgentEnv, definition, task, runId: execution.id, locale: 'en' } as never).resolve(definition, 'finish_strategy');
    const args = { outcome: 'no_change', reason: 'Keyword research answered the request', resume_when: '', judgment_summary: 'Library updated' };
    expect(tool.inputSchema.safeParse(args).success).toBe(true);
    for (const sql of ["create table seo_strategy_versions(id text,site_id text,run_id text,locale_version integer,status text,source_locale text,created_at text default '')",
      'create table seo_topic_territories(strategy_version_id text)', 'create table seo_keyword_clusters(strategy_version_id text)',
      'create table seo_strategy_keywords(strategy_version_id text)', 'create table seo_research_sources(strategy_version_id text)',
      'create table seo_strategy_documents(strategy_version_id text,doc_type text,body_md text)']) await db.prepare(sql).run();
    expect(await tool.execute!(args, {} as never)).toMatchObject({ outcome: 'no_change', strategy_version_id: '' });
    await db.prepare("insert into seo_strategy_versions(id,site_id,run_id,locale_version,status,source_locale) values('v2','site-1',?,2,'active','en')").bind(execution.id).run();
    await expect(tool.execute!(args, {} as never)).rejects.toThrow('submitted a strategy version');
  });

  it.each([29, 30, 38])('pins the model-facing and execution outcome schema to definition %s', async version => {
    const { db, execution } = await fixture();
    const task = { ...await requireTask(db, execution.id), definition_version: version };
    const registry = strategyTaskTools({ env: { DB: db } as RuntimeAgentEnv, definition, task });
    const tool = registry.resolve(definition, 'finish_strategy');
    for (const outcome of ['completed', 'waiting', 'paused', 'no_change']) {
      expect(tool.inputSchema.safeParse({ outcome, reason: 'Reason', resume_when: '', judgment_summary: 'Summary' }).success)
        .toBe(outcome !== 'no_change' || version !== 30);
    }
    expect(tool.version).toBe(version === 29 ? 1 : version === 30 ? 2 : 3);
  });
});
