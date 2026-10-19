import { STRATEGY_LIBRARY_INSTRUCTIONS } from './library-business-instructions';
// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { taskTestDb } from './task-test-db';
import { attachTask, taskForRun } from './task-store';
import { agentDefinition } from './definitions';
import { runConversationTask } from './conversation-runtime';
import { strategyTaskTools, STRATEGY_TASK_SYSTEM } from './strategy-task';
import { replayConversationResponse } from './conversation-replay';
import { strategyBaseline } from './strategy-baseline';
import { strategyInstructions } from './strategy-conversation';
import { readConversation } from './conversation-store';
import { persistStrategyBundle, strategyPayload } from '../lib/research/strategy-store';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';

it.each([[false, false], [true, false], [false, true]])('commits strategy versions with competition=%s and unchanged recommendations=%s', async (competition, unchanged) => {
  const f = taskTestDb();
  for (const file of ['0015_seo_strategy_agent.sql', '0035_locale_strategy_versions.sql']) {
    // @ts-ignore Test-only Node URL.
    f.sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
  }
  f.sqlite.exec("alter table seo_strategy_runs add column source_locale text default 'en'; insert into seo_strategy_runs(id,site_id) values('run-1','s');");
  // @ts-ignore Test-only Node URL.
  f.sqlite.exec(readFileSync(new URL('../../migrations/0055_strategy_report_snapshots.sql', import.meta.url), 'utf8'));
  f.sqlite.exec("alter table sites add column workspace_id text default 'w'; create table topics(id text primary key,site_id text,title_hint text,status text);");
  // @ts-ignore Test-only Node URL.
  f.sqlite.exec(readFileSync(new URL('../../migrations/0056_keyword_library.sql', import.meta.url), 'utf8'));
  f.sqlite.exec(readFileSync(new URL('../../migrations/0075_language_only_library.sql', import.meta.url).pathname, 'utf8'));
  const definition = { ...agentDefinition('strategy_research'), tools: agentDefinition('strategy_research').tools.filter(name => name !== 'open_keyword_library' && !name.includes('_library_')) };
  f.sqlite.exec("drop index if exists idx_seo_strategy_versions_run; alter table seo_strategy_versions add column submission_operation_id text not null default ''; create unique index submissions on seo_strategy_versions(submission_operation_id);");
  const task = await attachTask(f.db, f.run(), definition);
  if (!competition) {
    await f.db.prepare('update agent_tasks set definition_version=28 where id=?').bind(task.id).run();
    task.definition_version = 28;
  }
  await f.db.prepare('update agent_tasks set parameter_contract_version=0 where id=?').bind(task.id).run();
  task.parameter_contract_version = 0; // Legacy conversation compatibility.
  const env = { DB: f.db } as RuntimeAgentEnv;
  const step = { do: async (_key: string, config: unknown, fn?: () => Promise<unknown>) => (fn || config as () => Promise<unknown>)() } as RuntimeWorkflowStep;
  const model: Model<'openai-completions'> = { id: 'test', name: 'test', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid',
    reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const blueprint = {
    change_summary: 'Bounded pilot', research_scope_summary: 'English readers', executive_strategy: 'Validate a pilot before expanding',
    search_landscape: 'Demand remains unknown', selected_playbooks: 'Educational guides', site_architecture: '/guides', internal_linking: 'Connect related guides',
    roadmap: 'Validate demand', measurement: 'Qualified visits', risks_unknowns: 'Unmeasured demand', evidence_notes: 'No measured demand claimed',
    territories: [{ key: 't', name: 'Guides', priority_band: 'high', status: 'active', audience_summary: 'Readers', search_job_summary: 'Learn', business_goal: 'Understand product', conversion_goal: 'Trial', summary: 'Guides' }],
    clusters: [{ key: 'c', territory_key: 't', name: 'Learning', priority_band: 'high', status: 'active', strategic_role: 'Education', recommended_hub: '/guides', conversion_goal: 'Trial', summary: 'Learning' }],
  };
  // Tasks from definition v34 treat clusters as demand directions carrying their own evidence.
  const directionBlueprint = { ...blueprint, clusters: blueprint.clusters.map(cluster => ({ ...cluster, source_urls: [] as string[] })) };
  let requests = 0;
  let competingVersionId = '';
  const observations: string[] = [];
  const stream: StreamFn = async (model, context, options) => {
    expect(context.systemPrompt?.startsWith(STRATEGY_TASK_SYSTEM + '\n')).toBe(true);
    expect(context.systemPrompt).toContain(STRATEGY_LIBRARY_INSTRUCTIONS);
    observations.push(JSON.stringify(context.messages));
    if (competition && requests === 1) {
      f.sqlite.exec("insert into seo_strategy_runs(id,site_id) values('competitor','s')");
      competingVersionId = (await persistStrategyBundle({ db: f.db, siteId: 's', runId: 'competitor', sourceLocale: 'en', businessSnapshot: {}, citations: [],
        result: { territories: [], clusters: [], keywords: [], change_summary: 'Concurrent update', research_scope_summary: 'English', seo_strategy_md: 'Existing strategy', research_notes_md: 'Existing notes' } })).id;
    }
    const actions = [
      { name: 'create_strategy_blueprint', arguments: { expected_revision: 0, blueprint } },
      { name: 'submit_strategy', arguments: { expected_revision: 1, judgment_summary: 'A bounded pilot with explicit uncertainty; no demand numbers claimed.' } },
      ...(competition ? [{ name: 'submit_strategy', arguments: { expected_revision: 1, expected_base_version_id: competingVersionId, judgment_summary: 'Reconciled the competing version; retain the bounded pilot and explicit uncertainty.' } }] : []),
      { name: 'finish_strategy', arguments: { outcome: 'completed', reason: 'Strategy saved', resume_when: '', judgment_summary: 'Completed after a durable submission' } },
    ];
    const action = actions[requests++];
    if (!action) throw new Error('Unexpected model call after completion');
    const response: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'toolCall', id: `call-${requests}`, ...action }], stopReason: 'toolUse', timestamp: requests,
      usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return replayConversationResponse(response, stream)(model, context, options);
  };
  const input = { env, step, runId: task.active_run_id, definition, transport: { model, stream }, agent: {
    instructions: STRATEGY_TASK_SYSTEM,
    context: async () => ({ locale: 'en', sources: [{ sourceId: 'business_modules', version: 'product:2' }] }),
    tools: (current?: typeof task, operation?: Parameters<typeof strategyTaskTools>[0]['operation']) => strategyTaskTools({ env, step, definition, runId: task.active_run_id, locale: 'en', task: current, operation }),
    completionInstructions: 'Submit or finish with an explicit outcome.',
  } };
  expect(await runConversationTask(input)).toMatchObject({ status: 'completed', outcome: 'completed', output: { strategy_version: competition ? 3 : 1 } });
  const current = (await taskForRun(f.db, task.active_run_id))!;
  const history = (await readConversation(f.db, current))!;
  expect(history.instructions.startsWith(STRATEGY_TASK_SYSTEM + '\n')).toBe(true);
  const manifest = await f.db.prepare('select tool_manifest_json from agent_conversations where task_id=?').bind(task.id).first<{ tool_manifest_json: string }>();
  expect(manifest!.tool_manifest_json.includes('restore_strategy_reports')).toBe(competition);
  expect(history.calls.every(call => call.operation_id && call.result_sequence)).toBe(true);
  const payload = await strategyPayload(f.db, 's', 'en', undefined, { includeRuntime: false });
  expect(payload.strategy).toMatchObject({ version: competition ? 3 : 1, status: 'active' });
  expect(payload.stats).toMatchObject({ territories: 1, clusters: 1, keywords: 0, library_keywords: 0 });
  f.sqlite.exec(`insert into keyword_library_entries(id,workspace_id,site_id,locale,kind,name,normalized_name,data_json,revision,archived,created_at,updated_at) values
    ('k1','w','s','en','keyword','reply email','reply email','{}',1,0,'',''), ('k2','w','s','en','keyword','write email','write email','{}',1,0,'',''),
    ('k3','w','s','en','keyword','old term','old term','{}',1,1,'',''), ('c1','w','s','en','cluster','email','email','{}',1,0,'',''),
    ('k4','w','s','pt-BR','keyword','responder email','responder email','{}',1,0,'','')`);
  // The strategy page counts the language's active library keywords , not strategy draft keywords.
  expect((await strategyPayload(f.db, 's', 'en', undefined, { includeRuntime: false })).stats.library_keywords).toBe(2);
  f.sqlite.exec('delete from keyword_library_entries');
  // Versions from v34 carry no keyword map report; the library holds keywords.
  expect(Object.entries(payload.documents).filter(([, document]) => document).map(([type]) => type).sort())
    .toEqual(competition ? ['research_notes', 'strategy'] : ['keyword_map', 'research_notes', 'strategy']);
  expect(JSON.stringify(payload.documents)).toContain('Validate a pilot before expanding');
  expect(JSON.stringify(payload.documents)).toContain('No usable web sources were attached in this version');
  const saved = await f.db.prepare('select business_snapshot_json from seo_strategy_versions where status=\'active\'').first<{ business_snapshot_json: string }>();
  expect(JSON.parse(saved!.business_snapshot_json)).toEqual({ product: 2 });
  expect(await runConversationTask(input)).toMatchObject({ status: 'completed' });
  expect(requests).toBe(competition ? 4 : 3);
  if (competition) {
    expect(observations[2]).toContain('state_conflict');
    expect(observations[2]).toContain(competingVersionId);
    expect(history.messages.find(row => row.key === 'tool:call-2')?.message).toMatchObject({ isError: true });
    expect(current.revision).toBe(1);
  }
  expect((await f.db.prepare('select id from seo_strategy_versions').all()).results).toHaveLength(competition ? 3 : 1);
  f.sqlite.exec("insert into seo_strategy_runs(id,site_id) values('refresh','s')");
  const refresh = await attachTask(f.db, f.run('refresh'), definition);
  await f.db.prepare('update agent_tasks set parameter_contract_version=0 where id=?').bind(refresh.id).run();
  refresh.parameter_contract_version = 0;
  const active = (await f.db.prepare("select id from seo_strategy_versions where status='active'").first<{ id: string }>())!;
  // A historical source remains attributable when its structured draft is inherited.
  await f.db.prepare("insert into seo_research_sources(id,strategy_version_id,url,title,observation_md) values('historical-source',?,'https://example.com/old-source','Historical evidence','Earlier observation; freshness unverified')").bind(active.id).run();
  // From v36 the base version is read-only reference and is never copied into the new-version draft.
  const fresh = await strategyBaseline(f.db, refresh, 'en', active.id);
  expect(fresh.origin).toMatchObject({ kind: 'new_version_draft', version_id: active.id });
  expect(fresh.workspace.blueprint).toBeUndefined();
  // Persisted v35 tasks keep their inherited-draft contract.
  await f.db.prepare('update agent_tasks set definition_version=35 where id=?').bind(refresh.id).run();
  refresh.definition_version = 35;
  const baseline = await strategyBaseline(f.db, refresh, 'en', active.id);
  expect(baseline.origin).toEqual({ kind: 'completed_strategy', version_id: active.id });
  expect(baseline.workspace.blueprint).toEqual(directionBlueprint);
  expect((await strategyBaseline(f.db, { ...refresh, workspace_id: 'other' }, 'en', active.id)).origin.kind).toBe('documents_only');
  expect((await strategyBaseline(f.db, refresh, 'pt-BR', active.id)).origin.kind).toBe('documents_only');
  if (competition) expect((await strategyBaseline(f.db, refresh, 'en', competingVersionId)).origin).toMatchObject({ kind: 'documents_only', version_id: competingVersionId });

  const refreshStream: StreamFn = (model, context, options) => {
    expect(JSON.stringify(context.messages)).toContain('Validate a pilot before expanding');
    const response: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [
        ...(!unchanged ? [{ type: 'toolCall' as const, id: 'patch', name: 'patch_strategy_blueprint', arguments: { expected_revision: 0, blueprint: { roadmap: 'Validate the new audience' } } }] : []),
        { type: 'toolCall', id: 'done', name: 'submit_strategy', arguments: { expected_revision: unchanged ? 0 : 1, judgment_summary: 'Preserve inherited evidence with its limitations and update only the roadmap' } },
        { type: 'toolCall', id: 'finished', name: 'finish_strategy', arguments: { outcome: 'completed', reason: 'Revision saved', resume_when: '', judgment_summary: 'Completed after save' } },
      ], stopReason: 'toolUse', timestamp: 10,
      usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return replayConversationResponse(response, refreshStream)(model, context, options);
  };
  expect(await runConversationTask({ env, step, runId: refresh.active_run_id, definition, transport: { model, stream: refreshStream }, agent: {
    instructions: STRATEGY_TASK_SYSTEM, context: async () => ({ workspace: baseline.workspace, locale: 'en', base_strategy_version_id: active.id, sources: [] }),
    initialWorkspace: context => (context as { workspace: unknown }).workspace,
    tools: (task, operation) => strategyTaskTools({ env, step, definition, runId: refresh.active_run_id, locale: 'en', task, operation }),
    completionInstructions: 'Finish explicitly.',
  } })).toMatchObject({ status: 'completed' });
  const revised = (await taskForRun(f.db, refresh.active_run_id))!;
  expect(JSON.parse(revised.workspace_json).blueprint).toEqual(unchanged ? directionBlueprint : { ...directionBlueprint, roadmap: 'Validate the new audience' });
  expect(JSON.parse(current.workspace_json).blueprint).toEqual(competition ? directionBlueprint : blueprint);
  expect(revised.revision).toBe(unchanged ? 0 : 1);
  const latest = await strategyPayload(f.db, 's', 'en', undefined, { includeRuntime: false });
  expect(latest.strategy!.id).not.toBe(active.id);
  expect(latest.strategy!.version).toBe(payload.strategy!.version + 1);
  expect(await f.db.prepare('select status from seo_strategy_versions where id=?').bind(active.id).first()).toEqual({ status: 'superseded' });
  expect(latest.stats.sources).toBe(1);
  expect(JSON.stringify(latest.documents.research_notes)).toContain('https://example.com/old-source');

  // Real pipeline: report restoration is an ordinary mutation, not a terminal action.
  const target = latest.strategy!.id;
  const originalDocuments = latest.documents;
  await f.db.prepare('delete from seo_strategy_documents where strategy_version_id=?').bind(target).run();
  f.sqlite.exec("insert into seo_strategy_runs(id,site_id) values('restore','s')");
  const restoration = await attachTask(f.db, f.run('restore'), definition);
  // Persisted v29 conversations retain their original no-change contract.
  await f.db.prepare('update agent_tasks set definition_version=29 where id=?').bind(restoration.id).run();
  restoration.definition_version = 29;
  const versionsBefore = (await f.db.prepare('select id from seo_strategy_versions').all()).results;
  let restoreCalls = 0;
  const restoreStream: StreamFn = async (model, context, options) => {
    const index = restoreCalls++;
    if (index === 1) {
      expect((await taskForRun(f.db, restoration.id))!.status).toBe('running');
      expect(JSON.stringify(context.messages)).toContain('saved_version_snapshot');
    }
    const action = index === 0
      ? { name: 'restore_strategy_reports', arguments: { judgment_summary: 'Restore reports without changing the strategy' } }
      : { name: 'finish_strategy', arguments: { outcome: 'no_change', reason: 'Exact reports restored; strategy unchanged', resume_when: '', judgment_summary: 'Reports delivered' } };
    if (index > 1) throw new Error('Unexpected decision after explicit finish');
    const response: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'toolCall', id: `restore-${index}`, ...action }], stopReason: 'toolUse', timestamp: 20 + index,
      usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return replayConversationResponse(response, restoreStream)(model, context, options);
  };
  const restoreInput = { env, step, runId: restoration.active_run_id, definition, transport: { model, stream: restoreStream }, agent: {
    instructions: STRATEGY_TASK_SYSTEM, context: async () => ({ locale: 'en', base_strategy_version_id: target, sources: [] }),
    tools: (task?: typeof restoration, operation?: Parameters<typeof strategyTaskTools>[0]['operation']) => strategyTaskTools({ env, step, definition, runId: restoration.active_run_id, locale: 'en', task, operation }),
    completionInstructions: 'Finish explicitly after observing delivery.',
  } };
  expect(await runConversationTask(restoreInput)).toMatchObject({ status: 'completed', outcome: 'no_change', output: { report_delivery: { complete: true, version_id: target } } });
  expect(await runConversationTask(restoreInput)).toMatchObject({ status: 'completed', outcome: 'no_change' });
  expect(restoreCalls).toBe(2);
  const restored = await strategyPayload(f.db, 's', 'en', undefined, { includeRuntime: false });
  expect(restored.documents).toEqual(originalDocuments);
  expect(restored.run?.outcome).toBe('no_change');
  expect((await f.db.prepare('select id from seo_strategy_versions').all()).results).toEqual(versionsBefore);

});

it('pins v36 instructions to the new-version draft contract and keeps v35 text unchanged', () => {
  const current = strategyInstructions(36, 2);
  expect(current).toContain('its own new-version draft');
  expect(current).toContain('territory_create_key');
  expect(current).not.toContain('prefer patch_strategy_blueprint for subsequent targeted revisions.');
  const pinned = strategyInstructions(35, 2);
  expect(pinned).toContain('prefer patch_strategy_blueprint for subsequent targeted revisions.');
  expect(pinned).not.toContain('new-version draft');
});
