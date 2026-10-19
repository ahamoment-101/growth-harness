// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { taskTestDb } from './task-test-db';
import { attachTask, taskForRun } from './task-store';
import { agentDefinition } from './definitions';
import { runConversationTask } from './conversation-runtime';
import { strategyTaskTools } from './strategy-task';
import { replayConversationResponse } from './conversation-replay';
import { strategyBaseline } from './strategy-baseline';
import { strategyInstructions } from './strategy-conversation';
import { persistStrategyBundle } from '../lib/research/strategy-store';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';

it('writes v2 from an empty draft while v1 stays read-only, rejecting a v1 storage id as a draft selector', async () => {
  const f = taskTestDb();
  // @ts-ignore Test-only Node URL.
  for (const file of ['0015_seo_strategy_agent.sql', '0035_locale_strategy_versions.sql']) f.sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
  f.sqlite.exec("alter table seo_strategy_runs add column source_locale text default 'en'; insert into seo_strategy_runs(id,site_id) values('run-1','s'),('refresh','s');");
  // @ts-ignore Test-only Node URL.
  f.sqlite.exec(readFileSync(new URL('../../migrations/0055_strategy_report_snapshots.sql', import.meta.url), 'utf8'));
  f.sqlite.exec("alter table sites add column workspace_id text default 'w'; create table topics(id text primary key,site_id text,title_hint text,status text);");
  // @ts-ignore Test-only Node URL.
  f.sqlite.exec(readFileSync(new URL('../../migrations/0056_keyword_library.sql', import.meta.url), 'utf8'));
  f.sqlite.exec(readFileSync(new URL('../../migrations/0075_language_only_library.sql', import.meta.url).pathname, 'utf8'));
  f.sqlite.exec("drop index if exists idx_seo_strategy_versions_run; alter table seo_strategy_versions add column submission_operation_id text not null default ''; create unique index submissions on seo_strategy_versions(submission_operation_id);");
  const definition = { ...agentDefinition('strategy_research'), tools: agentDefinition('strategy_research').tools.filter(name => name !== 'open_keyword_library' && !name.includes('_library_')) };

  // v1 exists with structured territories/clusters, but no completed task owns it (the incident's cancelled producer).
  const v1 = await persistStrategyBundle({ db: f.db, siteId: 's', runId: 'run-1', sourceLocale: 'en', businessSnapshot: {}, citations: [],
    result: { change_summary: 'v1', research_scope_summary: 'English', seo_strategy_md: 'V1 strategy', research_notes_md: 'V1 notes', keywords: [],
      territories: [{ key: 'writing', name: 'Writing', priority_band: 'high', status: 'active', audience_summary: 'Pros', search_job_summary: 'Write', business_goal: 'Trial', conversion_goal: 'Trial', summary: 'Writing' }],
      clusters: [{ key: 'replies', territory_key: 'writing', name: 'Replies', priority_band: 'high', status: 'active', strategic_role: 'Task', recommended_hub: '/guides', conversion_goal: 'Trial', summary: 'Replies' }] } as any });
  const v1Rows = f.sqlite.prepare('select * from seo_keyword_clusters where strategy_version_id=?').all(v1.id);
  const v1ClusterId = String((v1Rows[0] as any).id);

  const task = await attachTask(f.db, f.run('refresh'), definition);
  expect(task.definition_version).toBeGreaterThanOrEqual(36);
  expect(task.parameter_contract_version).toBe(2);
  const env = { DB: f.db } as RuntimeAgentEnv;
  const step = { do: async (_key: string, config: unknown, fn?: () => Promise<unknown>) => (fn || config as () => Promise<unknown>)() } as RuntimeWorkflowStep;
  const model: Model<'openai-completions'> = { id: 'test', name: 'test', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid',
    reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const text = Object.fromEntries(['change_summary','research_scope_summary','executive_strategy','search_landscape','selected_playbooks','site_architecture','internal_linking','roadmap','measurement','risks_unknowns','evidence_notes'].map(key => [key, 'Kept Writing/Replies from v1; added Speaking']));
  const results: any[] = [];
  let calls = 0; let workspaceRef = '';
  const lastResult = (context: any) => { const m = [...context.messages].reverse().find((x: any) => x.role === 'toolResult'); return m ? { error: m.isError, body: JSON.parse(m.content[0].text) } : null; };
  const stream: StreamFn = async (m, context, options) => {
    const index = calls++;
    if (index > 0) results.push(lastResult(context));
    const actions: Array<() => { name: string; arguments: any }> = [
      () => ({ name: 'read_strategy_workspace', arguments: {} }),
      () => { workspaceRef = results[0].body.workspace_ref; return { name: 'read_strategy', arguments: { section: 'clusters' } }; },
      () => ({ name: 'patch_strategy_blueprint', arguments: { workspace_ref: workspaceRef, blueprint: {}, clusters: [{ ref: v1ClusterId, values: { summary: 'edit v1' } }] } }),
      () => ({ name: 'create_strategy_blueprint', arguments: { workspace_ref: workspaceRef, blueprint: text,
        territories: [{ create_key: 'w', values: { name: 'Writing', priority_band: 'high', status: 'active', audience_summary: 'Pros', search_job_summary: 'Write', business_goal: 'Trial', conversion_goal: 'Trial', summary: 'Writing' } },
          { create_key: 's', values: { name: 'Speaking', priority_band: 'medium', status: 'watch', audience_summary: 'Pros', search_job_summary: 'Speak', business_goal: 'Trial', conversion_goal: 'Trial', summary: 'Speaking' } }],
        clusters: [{ territory_create_key: 'w', values: { name: 'Replies', priority_band: 'high', status: 'active', strategic_role: 'Task', recommended_hub: '/guides', conversion_goal: 'Trial', summary: 'Replies', source_refs: [] } },
          { territory_create_key: 's', values: { name: 'Meetings', priority_band: 'medium', status: 'watch', strategic_role: 'Method', recommended_hub: '/guides', conversion_goal: 'Trial', summary: 'Meetings', source_refs: [] } }] } }),
      () => ({ name: 'submit_strategy', arguments: { workspace_ref: results[3].body.workspace_ref, judgment_summary: 'Rewrote the draft from read-only v1 plus new research' } }),
      () => ({ name: 'finish_strategy', arguments: { outcome: 'completed', reason: 'Submitted v2', resume_when: '', judgment_summary: 'Done' } }),
    ];
    const next = actions[index];
    if (!next) throw new Error('Unexpected model call');
    const response: AssistantMessage = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, content: [{ type: 'toolCall', id: `c${index}`, ...next() }],
      stopReason: 'toolUse', timestamp: index + 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return replayConversationResponse(response, stream)(m, context, options);
  };
  const outcome = await runConversationTask({ env, step, runId: task.active_run_id, definition, transport: { model, stream }, agent: {
    instructions: strategyInstructions(36, 2),
    context: async current => { const baseline = await strategyBaseline(f.db, current, 'en', v1.id);
      return { goal: {}, locale: 'en', task_id: current.id, revision: current.revision, base_strategy_version_id: v1.id, draft_origin: baseline.origin, sources: [], workspace: baseline.workspace }; },
    initialWorkspace: context => (context as { workspace: unknown }).workspace,
    tools: (current, operation) => strategyTaskTools({ env, step, definition, runId: task.active_run_id, locale: 'en', task: current, operation }),
    completionInstructions: 'Submit then finish.',
  } });
  expect(outcome).toMatchObject({ status: 'completed' });
  // 0: draft is empty and names read-only v1
  expect(results[0].body.draft).toEqual({ scope: 'this_task_new_version_draft', becomes: expect.any(String), state: 'empty', territories: 0, clusters: 0,
    base_version: { version: 1, access: 'read_only', read_with: 'read_strategy with empty version_id' } });
  // 1: v1 read has content only
  expect(results[1].body.access).toBe('read_only_historical_version');
  expect(JSON.stringify(results[1].body.items)).not.toContain(v1ClusterId);
  expect(results[1].body.items[0]).toMatchObject({ territory_name: 'Writing', name: 'Replies' });
  // 2: guessed v1 id rejected, no effect
  expect(results[2].body).toMatchObject({ kind: 'invalid_request', effects: 'none' });
  // 3: one-call create succeeded
  expect(results[3].error).toBeFalsy();
  expect(results[3].body.draft).toMatchObject({ state: 'has_blueprint', territories: 2, clusters: 2 });
  const versions = f.sqlite.prepare('select id,locale_version,status from seo_strategy_versions order by locale_version').all() as any[];
  expect(versions.map(v => [v.locale_version, v.status])).toEqual([[1, 'superseded'], [2, 'active']]);
  expect(f.sqlite.prepare('select * from seo_keyword_clusters where strategy_version_id=?').all(v1.id)).toEqual(v1Rows);
  const v2 = versions[1].id;
  const v2Clusters = f.sqlite.prepare('select c.name, t.name as territory from seo_keyword_clusters c join seo_topic_territories t on t.id=c.territory_id where c.strategy_version_id=? order by c.name').all(v2);
  expect(v2Clusters).toEqual([{ name: 'Meetings', territory: 'Speaking' }, { name: 'Replies', territory: 'Writing' }]);
  expect((await taskForRun(f.db, task.active_run_id))!.status).toBe('completed');
});
