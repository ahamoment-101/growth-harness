// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('agents', () => ({ getAgentByName: vi.fn() }));
import { taskTestDb } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, beginTaskDecision, finishTaskOperation, requireTask, setTaskAction, stopTask, taskForRun, type AgentTask } from './task-store';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution } from './runtime-executions';
import { executionEnvironment } from './execution-context';
import { startRuntimeRun, type StartRuntimeRunInput } from './run-service';
import { appendConversationMessage, initializeConversation } from './conversation-store';
import { conversationToolExecutor } from './conversation-tool-executor';
import { keywordResearchResult, keywordResearchTools } from './keyword-research';
import { STRATEGY_DIRECTION_TASK_SYSTEM, STRATEGY_TASK_SYSTEM, strategyTaskTools } from './strategy-task';
import { strategyInstructions } from './strategy-conversation';
import { STRATEGY_DIRECTION_SLOT_INSTRUCTIONS, STRATEGY_SLOT_INSTRUCTIONS } from './strategy-slots';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';

const step = { do: async (_key: string, config: unknown, fn?: () => Promise<unknown>) => (fn || config as () => Promise<unknown>)(), sleep: async () => {} } as unknown as RuntimeWorkflowStep;
const brief = { market: 'Global', research_question: 'Which English writing tasks do learners search for?', directions: ['reply to English emails'] };

function database() {
  const f = taskTestDb();
  f.sqlite.exec(`alter table sites add column workspace_id text default 'w'; alter table sites add column source_locale text default 'en';
    alter table sites add column translate_locales_json text default '["pt-BR"]'; alter table sites add column hub_path text default '';
    create table topics(id text primary key,site_id text,title_hint text,status text); alter table topics add column plan_json text default '{}';`);
  // @ts-ignore Test-only URL.
  f.sqlite.exec(readFileSync(new URL('../../migrations/0056_keyword_library.sql', import.meta.url), 'utf8'));
  f.sqlite.exec(readFileSync(new URL('../../migrations/0075_language_only_library.sql', import.meta.url).pathname, 'utf8'));
  f.sqlite.exec(readFileSync(new URL('../../migrations/0073_keyword_search_observations.sql', import.meta.url).pathname, 'utf8'));
  return f;
}

async function scopedParent(f: ReturnType<typeof database>, agentId: 'strategy_research' | 'content_production' = 'strategy_research') {
  const run = f.run();
  const definition = agentDefinition(agentId);
  await f.db.prepare('update agent_runs set agent_id=?,definition_version=?,prompt_version=? where id=?').bind(agentId, definition.definitionVersion, definition.promptVersion, run.id).run();
  const parent = await attachTask(f.db, { ...run, agent_id: agentId }, definition);
  const execution = await createRuntimeExecution(f.db, parent.active_run_id);
  await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  return { parent, env: (host: RuntimeAgentEnv) => executionEnvironment(host, authorityForExecution(execution)) };
}

async function scopedChild(f: ReturnType<typeof database>, summary: Record<string, unknown>, credentials: Partial<RuntimeAgentEnv> = {}) {
  const definition = agentDefinition('keyword_research');
  const run = f.run('child', 'child');
  await f.db.prepare('update agent_runs set agent_id=?,definition_version=?,prompt_version=?,summary_json=? where id=?')
    .bind('keyword_research', definition.definitionVersion, definition.promptVersion, JSON.stringify(summary), run.id).run();
  await attachTask(f.db, { ...run, agent_id: 'keyword_research', summary_json: JSON.stringify(summary) }, definition);
  const execution = await createRuntimeExecution(f.db, run.id);
  const authority = authorityForExecution(execution);
  await activateRuntimeExecution(f.db, authority, execution.workflow_id);
  const env = executionEnvironment({ ...credentials, DB: f.db } as RuntimeAgentEnv, authority);
  const call = async (name: string, args: Record<string, unknown>) => {
    const task = await requireTask(env.DB, run.id);
    const operation = await beginTaskDecision(env.DB, task, {});
    await setTaskAction(env.DB, task, operation, { name, input: args });
    const registry = keywordResearchTools({ env, definition, task, operation });
    const tool = registry.resolve(definition, name);
    let output: Record<string, any>;
    try {
      output = await registry.execute(definition, name, args, { workspaceId: 'w', siteId: 's', runId: run.id, idempotencyKey: operation.id, execution: authority }) as Record<string, any>;
    } catch (error) {
      await finishTaskOperation(env.DB, task, operation, { error: String(error) });
      throw error;
    }
    await finishTaskOperation(env.DB, task, operation, output);
    return { output, completion: tool.completion?.(output) };
  };
  const executeDurable = conversationToolExecutor({ env, step, runId: run.id, definition, scopedTools: (task, operation) => keywordResearchTools({ env, definition, task, operation }) });
  await initializeConversation(env.DB, await requireTask(env.DB, run.id), 'Keyword research', summary);
  const savedCalls = new Set<string>();
  const durableCall = async (name: string, callId: string, args: Record<string, unknown>) => {
    const task = await requireTask(env.DB, run.id);
    if (!savedCalls.has(callId)) {
      await appendConversationMessage(env.DB, task, `assistant:${callId}`, {
        role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: args }],
        api: 'openai-completions', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      savedCalls.add(callId);
    }
    const output = await executeDurable(name, callId, args);
    await appendConversationMessage(env.DB, await requireTask(env.DB, run.id), `result:${callId}`, {
      role: 'toolResult', toolCallId: callId, toolName: name, content: output.content, details: output.details, isError: false, timestamp: 2,
    });
    return output;
  };
  return { run, env, call, durableCall };
}

describe('keyword research sub-Agent start authority', () => {
  it('starts only under an allowed parent with its own identity and a bound language', async () => {
    const f = database();
    const { parent, env } = await scopedParent(f);
    const create = vi.fn(async (options: { id: string }) => ({ id: options.id }));
    const scoped = env({ DB: f.db, AGENT_WORKFLOW: { create } } as unknown as RuntimeAgentEnv);
    const request: StartRuntimeRunInput = { runId: 'child', instanceId: 'child', workspaceId: 'w', siteId: 's', agentId: 'keyword_research',
      trigger: 'sub_agent', parentRunId: parent.active_run_id, summary: { ...brief, locale: 'en' } };
    const child = await startRuntimeRun(scoped, request);
    const task = (await taskForRun(f.db, child.id))!;
    expect(task.parent_task_id).toBe(parent.id);
    expect(JSON.parse(task.goal_json)).toMatchObject({ locale: 'en', directions: ['reply to English emails'] });
    expect(create).toHaveBeenCalledOnce();
    await expect(startRuntimeRun(scoped, { ...request, runId: 'other', instanceId: 'other', summary: { ...brief, locale: 'ja' } })).rejects.toThrow('languages enabled for the project');
    const host = { DB: f.db, AGENT_WORKFLOW: { create } } as unknown as RuntimeAgentEnv;
    await expect(startRuntimeRun(host, { ...request, runId: 'manual', instanceId: 'manual', trigger: 'manual', parentRunId: undefined })).rejects.toThrow('can only be started');
  });

  it('rejects a parent Agent that is not allowed to commission library research', async () => {
    const f = database();
    const { parent, env } = await scopedParent(f, 'content_production');
    const scoped = env({ DB: f.db, AGENT_WORKFLOW: { create: vi.fn() } } as unknown as RuntimeAgentEnv);
    await expect(startRuntimeRun(scoped, { runId: 'child', instanceId: 'child', workspaceId: 'w', siteId: 's', agentId: 'keyword_research',
      trigger: 'sub_agent', parentRunId: parent.active_run_id, summary: { ...brief, locale: 'en' } })).rejects.toThrow('parent is not allowed');
    expect(await taskForRun(f.db, 'child')).toBeNull();
  });
});

describe('keyword research library contract', () => {
  it('writes only the briefed language and returns actual change receipts with its conclusions', async () => {
    const f = database();
    const { call, env, run } = await scopedChild(f, { ...brief, locale: 'en' });
    await expect(call('open_keyword_library', { locale: 'en', market: 'global' })).rejects.toThrow();
    await expect(call('open_keyword_library', { locale: 'pt-BR' })).rejects.toThrow('Language is outside this task');
    const library = (await call('open_keyword_library', { locale: 'en' })).output;
    await call('create_library_keyword', { library_ref: library.library_ref, name: 'how to reply to an email in English', data: { priority: 'medium' }, reason: 'Reply scenario appears in suggested terms' });
    const finish = { outcome: 'partial', summary: 'Email reply direction has been added to the keyword library', reason: 'Remaining directions pending supplementation',
      direction_results: [{ direction: 'reply to English emails', result: 'library_updated', explanation: 'Reply scenario appears in both suggested terms and result pages' }] };
    const finished = await call('finish_keyword_research', finish);
    expect(finished.completion).toMatchObject({ status: 'completed', outcome: 'partial' });
    await stopTask(f.db, run.id, 'completed', finish.reason, 'partial', finished.output);
    const result = await keywordResearchResult(env, (await taskForRun(f.db, run.id))!);
    expect(result).toMatchObject({ status: 'completed', outcome: 'partial', library: { locale: 'en' },
      direction_results: finish.direction_results });
    expect(result.library_changes).toEqual([expect.objectContaining({ action: 'create_keyword', kind: 'keyword', name: 'how to reply to an email in English' })]);
  });

  it('groups entries from receipts, earlier observations or ids while content revisions keep requiring the latest observation', async () => {
    const f = database();
    const { call } = await scopedChild(f, { ...brief, locale: 'en' });
    const library = (await call('open_keyword_library', { locale: 'en' })).output;
    const create = async (kind: string, name: string) => (await call(`create_library_${kind}`, { library_ref: library.library_ref, name, data: {}, reason: 'Grouping' })).output;
    const group = await create('topic_group', 'Email practice');
    const cluster = await create('cluster', 'Reply practice');
    const first = await create('keyword', 'email reply practice');
    const second = await create('keyword', 'reply to email exercises');
    const attached = (await call('organize_library_membership', { library_ref: library.library_ref, parent: group.observation_ref, child: cluster.observation_ref, present: true, reason: 'Needs under the direction' })).output;
    const clusterRef = attached.related[0].observation_ref;
    const one = (await call('organize_library_membership', { library_ref: library.library_ref, parent: clusterRef, child: first.observation_ref, present: true, reason: 'Same need' })).output;
    await call('organize_library_membership', { library_ref: library.library_ref, parent: one.observation_ref, child: second.observation_ref, present: true, reason: 'Same need' });
    // Relationship writes accept earlier observations and ids; content revisions still require the latest observation.
    await call('organize_library_membership', { library_ref: library.library_ref, parent: clusterRef, child: second.observation_ref, present: false, reason: 'Old reference released' });
    expect(f.sqlite.prepare('select count(*) as n from keyword_library_memberships').get()).toEqual({ n: 2 });
    await call('organize_library_membership', { library_ref: library.library_ref, parent: cluster.target_id, child: second.target_id, present: true, reason: 'Restore by ID' });
    expect(f.sqlite.prepare('select count(*) as n from keyword_library_memberships').get()).toEqual({ n: 3 });
    await expect(call('organize_library_membership', { library_ref: library.library_ref, parent: 'missing-entry', child: second.target_id, present: true, reason: 'Does not exist' })).rejects.toThrow('not present in this language');
    await expect(call('revise_library_keyword', { library_ref: library.library_ref, reference: first.observation_ref, data: { priority: 'high' }, reason: 'Old version' })).rejects.toThrow('differs from current revision');
  });

  it('reports saved changes from an unfinished task without inventing conclusions', async () => {
    const f = database();
    const { call, env, run } = await scopedChild(f, { ...brief, locale: 'en' });
    const library = (await call('open_keyword_library', { locale: 'en' })).output;
    await call('create_library_keyword', { library_ref: library.library_ref, name: 'english email reply examples', data: {}, reason: 'Result page samples' });
    await stopTask(f.db, run.id, 'paused', 'provider unavailable', 'execution_failed');
    const result = await keywordResearchResult(env, (await taskForRun(f.db, run.id))!);
    expect(result).toMatchObject({ status: 'paused', resumable: true, summary: '', direction_results: [], reason: 'provider unavailable' });
    expect(result.library_changes).toHaveLength(1);
  });
});

describe('strategy keyword delegation contract', () => {
  function registry(task: AgentTask) {
    return strategyTaskTools({ env: { DB: {} } as unknown as RuntimeAgentEnv, definition: agentDefinition('strategy_research'), step, runId: task.active_run_id,
      task, operation: { id: 'op' } as never, locale: 'en' }).names();
  }

  it('delegates library writes and drops the strategy keyword list from v34 while earlier tasks keep their pinned contract', () => {
    const current = { definition_version: 34, parameter_contract_version: 2, active_run_id: 'run' } as AgentTask;
    expect(registry(current)).toContain('research_keywords');
    expect(registry(current)).toContain('read_library_entry');
    expect(registry(current)).toContain('deep_research');
    expect(registry(current)).not.toContain('create_library_keyword');
    expect(registry(current)).not.toContain('update_strategy_keywords');
    const pinned = { ...current, definition_version: 33 };
    expect(registry(pinned)).toContain('create_library_keyword');
    expect(registry(pinned)).toContain('update_strategy_keywords');
    expect(registry(pinned)).not.toContain('research_keywords');
  });

  it('pins direction-level instructions with the research division from v34 and keeps earlier text unchanged', () => {
    expect(strategyInstructions(33, 2)).toBe(STRATEGY_TASK_SYSTEM + '\n' + STRATEGY_SLOT_INSTRUCTIONS);
    const current = strategyInstructions(34, 2);
    expect(current.startsWith(STRATEGY_DIRECTION_TASK_SYSTEM + '\n' + STRATEGY_DIRECTION_SLOT_INSTRUCTIONS)).toBe(true);
    expect(current).toContain('## Research division');
    expect(current).toContain('The strategy does not maintain concrete keywords');
    expect(current).not.toContain('update_strategy_keywords');
    expect(current).not.toContain('When library mutation tools are available');
    expect(current).toContain('## 6. SEO playbook know-how');
    expect(current).toContain('Never write evidence refs');
    expect(current).toContain('Clusters are demand directions: attach their supporting evidence with source_refs');
  });

  it('gives the keyword research sub-Agent search-expression tools but no market research delegation', () => {
    const names = keywordResearchTools({ env: { DB: {} } as unknown as RuntimeAgentEnv, definition: agentDefinition('keyword_research') }).names();
    expect(names).toEqual(expect.arrayContaining(['fetch_autocomplete', 'strategy_search_web', 'read_web_page', 'read_evidence', 'create_library_keyword', 'finish_keyword_research']));
    expect(names).not.toContain('deep_research');
  });

  it('commissions one child with a host-bound language and returns its result', async () => {
    const f = database();
    const { parent, env } = await scopedParent(f);
    const create = vi.fn(async (options: { id: string; params: { runId: string } }) => {
      await stopTask(f.db, options.params.runId, 'completed', 'done', 'no_findings', { outcome: 'no_findings', summary: 'No supportable needs found', reason: 'done', direction_results: [] });
      return { id: options.id };
    });
    const scoped = env({ DB: f.db, AGENT_WORKFLOW: { create } } as unknown as RuntimeAgentEnv);
    const task = await requireTask(scoped.DB, parent.active_run_id);
    const operation = await beginTaskDecision(scoped.DB, task, {});
    const args = { ...brief, locale: 'pt-BR', resume_task_id: '', judgment_summary: '' };
    await setTaskAction(scoped.DB, task, operation, { name: 'research_keywords', input: args });
    const tools = strategyTaskTools({ env: scoped, definition: agentDefinition('strategy_research'), step, runId: task.active_run_id, task, operation, locale: 'en' });
    const result = await tools.resolve(agentDefinition('strategy_research'), 'research_keywords').execute!(args, { workspaceId: 'w', siteId: 's', runId: task.active_run_id, idempotencyKey: operation.id }) as Record<string, any>;
    expect(result).toMatchObject({ status: 'completed', outcome: 'no_findings', library: { locale: 'en' }, summary: 'No supportable needs found' });
    const child = (await taskForRun(f.db, result.task_id))!;
    expect(child).toMatchObject({ agent_id: 'keyword_research', parent_task_id: parent.id });
    expect(create).toHaveBeenCalledOnce();
  });
});

const searchCredentials = { DATAFORSEO_LOGIN: 'fixture@example.com', DATAFORSEO_PASSWORD: 'fixture-password' };
const searchReply = (result: unknown) => new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.01, result: [result] }] }));
afterEach(() => vi.unstubAllGlobals());

describe('optional keyword Agent search data', () => {
  it('keeps existing research and completion available without credentials and makes no provider call', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const f = database();
    const child = await scopedChild(f, { ...brief, locale: 'en' });
    const status = (await child.call('read_keyword_search_data', {})).output;
    expect(status).toMatchObject({ configured: false, missing: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'], observations: [] });
    await expect(child.call('lookup_keyword_metrics', { country: 'US', keywords: ['email'] })).rejects.toMatchObject({ assessment: { kind: 'not_configured', effects: 'none' } });
    const names = keywordResearchTools({ env: child.env, definition: agentDefinition('keyword_research') }).names();
    expect(names).toEqual(expect.arrayContaining(['fetch_autocomplete', 'strategy_search_web', 'read_gsc_performance', 'finish_keyword_research']));
    expect((await child.call('open_keyword_library', { locale: 'en' })).output.library_ref).toBeTruthy();
    const finished = await child.call('finish_keyword_research', { outcome: 'partial', summary: 'Existing materials reviewed; measured demand remains unknown.', direction_results: [], reason: 'No measured demand available.' });
    expect(finished.completion).toMatchObject({ status: 'completed', outcome: 'partial' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('pins new tools by task version, not by whether keys are present', async () => {
    const f = database();
    const child = await scopedChild(f, { ...brief, locale: 'en' });
    const task = (await taskForRun(f.db, child.run.id))!;
    const definition = agentDefinition('keyword_research');
    const names = (env: RuntimeAgentEnv, version: number) => keywordResearchTools({ env, definition, task: { ...task, definition_version: version } }).names();
    expect(names(child.env, 7)).not.toContain('lookup_keyword_metrics');
    expect(names(child.env, 8)).toContain('lookup_keyword_metrics');
    expect(names({ ...child.env, ...searchCredentials }, 8)).toEqual(names(child.env, 8));
    const partial = await scopedChild(database(), { ...brief, locale: 'en' }, { DATAFORSEO_LOGIN: 'fixture@example.com' });
    expect((await partial.call('read_keyword_search_data', {})).output).toMatchObject({ configured: false, missing: ['DATAFORSEO_PASSWORD'] });
  });

  it('sends host-bound language, persists both data types and reuses the same operation receipt', async () => {
    const fetch = vi.fn().mockImplementationOnce(async () => searchReply({ items: [{ keyword: 'email', keyword_info: { search_volume: 120 }, keyword_properties: { keyword_difficulty: 9 } }] }))
      .mockImplementationOnce(async () => searchReply({ item_types: ['organic', 'people_also_ask'], items: [{ type: 'organic', rank_group: 1, url: 'https://example.com/', title: 'Email', domain: 'example.com' }] }));
    vi.stubGlobal('fetch', fetch);
    const f = database();
    const child = await scopedChild(f, { ...brief, locale: 'pt-BR' }, searchCredentials);
    const args = { country: 'BR', keywords: ['email', 'unknown'] };
    const first = await child.durableCall('lookup_keyword_metrics', 'metrics-1', args);
    const replay = await child.durableCall('lookup_keyword_metrics', 'metrics-1', args);
    expect(replay).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain('/dataforseo_labs/google/keyword_overview/live');
    expect(JSON.parse(init.body)).toEqual([{ keywords: args.keywords, location_code: 2076, language_code: 'pt' }]);
    await child.durableCall('lookup_keyword_serp', 'serp-1', { country: 'BR', keyword: 'email' });
    const saved = (await child.call('read_keyword_search_data', { keywords: args.keywords })).output;
    expect(saved.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'email', metrics: [expect.objectContaining({ search_volume: 120, country: 'BR' })], serp: [expect.objectContaining({ features: ['people_also_ask'] })] }),
      expect.objectContaining({ keyword: 'unknown', metrics: [expect.objectContaining({ search_volume: null })] }),
    ]));
    const rows = await f.db.prepare('select workspace_id,site_id,language,request_id,request_cost_usd from keyword_search_observations').all();
    expect(rows.results).toHaveLength(3);
    expect(rows.results).toEqual(expect.arrayContaining([expect.objectContaining({ workspace_id: 'w', site_id: 's', language: 'pt', request_cost_usd: 0.01 })]));
    await f.db.prepare("update keyword_search_observations set language='ja'").run();
    expect((await child.call('read_keyword_search_data', { keywords: args.keywords })).output.observations).toEqual([]);
    await f.db.prepare("update keyword_search_observations set language='pt',site_id='other-site'").run();
    expect((await child.call('read_keyword_search_data', { keywords: args.keywords })).output.observations).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects forged scope and unsupported parameters before dispatch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const child = await scopedChild(database(), { ...brief, locale: 'en' }, searchCredentials);
    for (const args of [{ country: 'US', keywords: ['x'], locale: 'ja' }, { country: 'US', keywords: ['x'], site_id: 'other' }, { country: 'IS', keywords: ['x'] }]) {
      await expect(child.call('lookup_keyword_metrics', args)).rejects.toThrow();
    }
    await expect(child.call('lookup_keyword_serp', { country: 'US', keyword: 'x', depth: 23 })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns safe typed account failures and preserves earlier observations', async () => {
    const fetch = vi.fn().mockImplementationOnce(async () => searchReply({ items: [] }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ status_code: 40104, status_message: searchCredentials.DATAFORSEO_PASSWORD }), { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    const child = await scopedChild(database(), { ...brief, locale: 'en' }, searchCredentials);
    await child.call('lookup_keyword_metrics', { country: 'US', keywords: ['email'] });
    const error = await child.call('lookup_keyword_metrics', { country: 'US', keywords: ['new'] }).catch(error => error);
    expect(error).toMatchObject({ assessment: { kind: 'not_authorized', retryable: false, effects: 'none' } });
    expect(error.message).toContain('40104');
    expect(error.message).not.toContain(searchCredentials.DATAFORSEO_PASSWORD);
    expect((await child.call('read_keyword_search_data', { keywords: ['email'] })).output.observations).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not dispatch after task cancellation', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const f = database();
    const child = await scopedChild(f, { ...brief, locale: 'en' }, searchCredentials);
    await stopTask(f.db, child.run.id, 'cancelled', 'Owner cancelled');
    await expect(child.durableCall('lookup_keyword_metrics', 'cancelled-1', { country: 'US', keywords: ['email'] })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not repeat a paid request with an unknown transport outcome', async () => {
    const fetch = vi.fn(async () => { throw new Error('Connection lost after dispatch'); }); vi.stubGlobal('fetch', fetch);
    const child = await scopedChild(database(), { ...brief, locale: 'en' }, searchCredentials);
    const args = { country: 'US', keywords: ['email'] };
    await expect(child.durableCall('lookup_keyword_metrics', 'unknown-1', args)).rejects.toThrow('unknown');
    await expect(child.durableCall('lookup_keyword_metrics', 'unknown-1', args)).rejects.toThrow('reconciliation');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
