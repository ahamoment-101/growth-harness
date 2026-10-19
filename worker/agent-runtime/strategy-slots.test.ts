import { it, expect } from 'vitest';
import { taskTestDb } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, requireTask, beginTaskDecision, setTaskAction, finishTaskOperation } from './task-store';
import { strategyTaskTools, strategyWorkspace } from './strategy-task';
import type { RuntimeAgentEnv } from './env';
import { renderStrategyMarkdown } from '../lib/research/ingest';

it('creates system identities, patches by reference, preserves sibling keywords and rejects stale observations', async () => {
  const { db, run } = taskTestDb(); const execution = run(); const definition = agentDefinition('strategy_research');
  await attachTask(db, execution, definition);
  // Keyword lists are a pinned pre-v34 contract; later tasks delegate keywords to the library.
  await db.prepare('update agent_tasks set definition_version=33 where id=?').bind(execution.id).run();
  async function call(name: string, args: any): Promise<any> {
    const task = await requireTask(db, execution.id); const operation = await beginTaskDecision(db, task, {});
    await setTaskAction(db, task, operation, {name, input: args});
    const registry = strategyTaskTools({env: { DB: db } as RuntimeAgentEnv, definition, task, operation, runId: execution.id, locale: 'en'});
    try { const value = await registry.execute(definition, name, args, {runId: execution.id, workspaceId: task.workspace_id, siteId: task.site_id, idempotencyKey: operation.id}); await finishTaskOperation(db, task, operation, value); return value; }
    catch (error) { await finishTaskOperation(db, task, operation, {}, String(error)); throw error; }
  }
  const first = await call('read_strategy_workspace', {});
  const text = Object.fromEntries(['change_summary','research_scope_summary','executive_strategy','search_landscape','selected_playbooks','site_architecture','internal_linking','roadmap','measurement','risks_unknowns','evidence_notes'].map(key => [key, 'Evidence unknown']));
  let view = await call('create_strategy_blueprint', {workspace_ref: first.workspace_ref, blueprint: text, territories: [{values: {name:'Learning',priority_band:'medium',status:'active',audience_summary:'Learners',search_job_summary:'Learn',business_goal:'Trial',conversion_goal:'Trial',summary:'Unknown'}}]});
  const territory = view.workspace.blueprint.territories[0];
  expect(territory.key).toMatch(/^[a-f0-9-]{36}$/);
  view = await call('patch_strategy_blueprint', {workspace_ref: view.workspace_ref, blueprint: {}, clusters: [{territory_ref: territory.ref, values:{name:'Practice',priority_band:'medium',status:'active',strategic_role:'Practice',recommended_hub:'Unknown',conversion_goal:'Trial',summary:'Unknown'}}]});
  const cluster = view.workspace.blueprint.clusters[0];
  const gb = await call('read_strategy_workspace', {});
  const values = {term:'language practice',cluster_ref:cluster.ref,source_refs:[],existing_page:{state:'unknown',page_ref:''},intent:'informational',journey_stage:'problem',serp_shape:'Unknown',recommended_page_type:'guide',business_relevance:'Hypothesis',conversion_route:'Trial',priority_band:'medium',priority_rationale:'Unknown',coverage_status:'uncovered',decision:'watch',evidence_summary:'Unknown'};
  view = await call('update_strategy_keywords', {workspace_ref: gb.workspace_ref, create: ['language practice','email practice'].map(term => ({...values,term}))});
  const stale = view.workspace_ref;
  const target = view.workspace.keywords.find((k:any)=>k.term==='language practice');
  view = await call('update_strategy_keywords', {workspace_ref: view.workspace_ref, patch:[{keyword_ref:target.ref,changes:{business_relevance:'Revised hypothesis'}}]});
  expect(view.workspace.keywords.map((k:any)=>k.term)).toEqual(['language practice','email practice']);
  expect(view.workspace.keywords[0].id).toBe(target.id);
  await expect(call('update_strategy_keywords', {workspace_ref:stale,patch:[{keyword_ref:target.ref,changes:{term:'changed'}}]})).rejects.toThrow('revision changed');
  await expect(call('update_strategy_keywords', {workspace_ref:view.workspace_ref,patch:[{keyword_ref:target.ref,changes:{source_refs:['invented']}}]})).rejects.toThrow('reference');
  await expect(call('update_strategy_keywords', {workspace_ref:view.workspace_ref,create:[values]})).rejects.toThrow('already exists');
  const beforeRename = view.workspace.keywords[0];
  view = await call('update_strategy_keywords', {workspace_ref:view.workspace_ref, patch:[{keyword_ref:beforeRename.ref, changes:{term:'renamed practice'}}]});
  expect(view.workspace.keywords.find((k:any)=>k.id===beforeRename.id).term).toBe('renamed practice');
  const receipt = await db.prepare("select output_json from agent_task_operations where task_id=? and status='succeeded' order by turn desc limit 1").bind(execution.id).first<{output_json:string}>();
  expect(JSON.parse(receipt!.output_json).workspace_ref).toBe(view.workspace_ref);
  expect(strategyWorkspace(await requireTask(db, execution.id)).keywords).toHaveLength(2);
});

it('attaches demand-direction evidence by catalog reference and renders readable sources from v34', async () => {
  const { db, run } = taskTestDb(); const execution = run(); const definition = agentDefinition('strategy_research');
  await attachTask(db, execution, definition);
  const url = 'https://example.com/email-practice';
  const observed = await requireTask(db, execution.id); const observation = await beginTaskDecision(db, observed, {});
  await setTaskAction(db, observed, observation, { name: 'read_web_page', input: { url, purpose: 'Observe a results page' } });
  await finishTaskOperation(db, observed, observation, { url, title: 'Email practice exercises', excerpt: 'Observed practice page' });
  async function call(name: string, args: any): Promise<any> {
    const task = await requireTask(db, execution.id); const operation = await beginTaskDecision(db, task, {});
    await setTaskAction(db, task, operation, {name, input: args});
    const registry = strategyTaskTools({env: { DB: db } as RuntimeAgentEnv, definition, task, operation, runId: execution.id, locale: 'en'});
    try { const value = await registry.execute(definition, name, args, {runId: execution.id, workspaceId: task.workspace_id, siteId: task.site_id, idempotencyKey: operation.id}); await finishTaskOperation(db, task, operation, value); return value; }
    catch (error) { await finishTaskOperation(db, task, operation, {}, String(error)); throw error; }
  }
  const names = strategyTaskTools({ env: { DB: db } as RuntimeAgentEnv, definition, task: observed, operation: observation, runId: execution.id, locale: 'en' }).names();
  expect(names).not.toContain('update_strategy_keywords');
  expect(names).not.toContain('fetch_autocomplete');
  const first = await call('read_strategy_workspace', {});
  const source = first.sources.find((item: any) => item.url === url);
  const text = Object.fromEntries(['change_summary','research_scope_summary','executive_strategy','search_landscape','selected_playbooks','site_architecture','internal_linking','roadmap','measurement','risks_unknowns','evidence_notes'].map(key => [key, 'Evidence unknown']));
  let view = await call('create_strategy_blueprint', {workspace_ref: first.workspace_ref, blueprint: text, territories: [{values: {name:'Writing',priority_band:'high',status:'active',audience_summary:'Learners',search_job_summary:'Practise',business_goal:'Trial',conversion_goal:'Trial',summary:'Writing'}}]});
  const territory = view.workspace.blueprint.territories[0];
  const direction = {name:'Reply practice',priority_band:'high',status:'active',strategic_role:'Task to complete',recommended_hub:'Guides',conversion_goal:'Trial',summary:'Practise replies'};
  await expect(call('patch_strategy_blueprint', {workspace_ref: view.workspace_ref, blueprint: {}, clusters: [{territory_ref: territory.ref, values: {...direction, source_refs: ['invented']}}]})).rejects.toThrow('reference');
  view = await call('patch_strategy_blueprint', {workspace_ref: view.workspace_ref, blueprint: {}, clusters: [{territory_ref: territory.ref, values: {...direction, source_refs: [source.ref]}}]});
  expect(view.workspace.blueprint.clusters[0]).toMatchObject({ source_urls: [url], source_refs: [source.ref] });
  view = await call('patch_strategy_blueprint', {workspace_ref: view.workspace_ref, blueprint: {}, clusters: [{ref: view.workspace.blueprint.clusters[0].ref, values: {summary: 'Revised'}}]});
  expect(view.workspace.blueprint.clusters[0]).toMatchObject({ summary: 'Revised', source_urls: [url] });
  const markdown = renderStrategyMarkdown(strategyWorkspace(await requireTask(db, execution.id)).blueprint!, { directions: { citations: [{ url, title: 'Email practice exercises', content: '' }] } });
  expect(markdown).toContain('Demand direction: Reply practice');
  expect(markdown).toContain(`[Email practice exercises](${url})`);
  expect(markdown).not.toMatch(/ref-[0-9a-f]{16}/);
});

it('writes the first v36 new-version draft in one call and keeps earlier versions out of draft selectors', async () => {
  const { db, run } = taskTestDb(); const execution = run(); const definition = agentDefinition('strategy_research');
  const attached = await attachTask(db, execution, definition);
  expect(attached.definition_version).toBeGreaterThanOrEqual(36);
  async function call(name: string, args: any): Promise<any> {
    const task = await requireTask(db, execution.id); const operation = await beginTaskDecision(db, task, {});
    await setTaskAction(db, task, operation, {name, input: args});
    const registry = strategyTaskTools({env: { DB: db } as RuntimeAgentEnv, definition, task, operation, runId: execution.id, locale: 'en'});
    try { const value = await registry.execute(definition, name, args, {runId: execution.id, workspaceId: task.workspace_id, siteId: task.site_id, idempotencyKey: operation.id}); await finishTaskOperation(db, task, operation, value); return value; }
    catch (error) { await finishTaskOperation(db, task, operation, {}, String(error)); throw error; }
  }
  const first = await call('read_strategy_workspace', {});
  expect(first.draft).toMatchObject({ scope: 'this_task_new_version_draft', state: 'empty', territories: 0, clusters: 0, base_version: null });
  const text = Object.fromEntries(['change_summary','research_scope_summary','executive_strategy','search_landscape','selected_playbooks','site_architecture','internal_linking','roadmap','measurement','risks_unknowns','evidence_notes'].map(key => [key, 'Evidence unknown']));
  const territory = (name: string) => ({name,priority_band:'high',status:'active',audience_summary:'Learners',search_job_summary:'Practise',business_goal:'Trial',conversion_goal:'Trial',summary:name});
  const direction = (name: string) => ({name,priority_band:'high',status:'active',strategic_role:'Task to complete',recommended_hub:'Guides',conversion_goal:'Trial',summary:name,source_refs:[]});
  const blueprint = (clusters: any[]) => ({workspace_ref: first.workspace_ref, blueprint: text,
    territories: [{create_key: 'writing', values: territory('Writing')}, {create_key: 'speaking', values: territory('Speaking')}], clusters});

  await expect(call('create_strategy_blueprint', blueprint([{territory_create_key: 'reading', values: direction('Replies')}]))).rejects.toThrow('create_key');
  await expect(call('create_strategy_blueprint', blueprint([{territory_create_key: 'writing', territory_ref: 'invented', values: direction('Replies')}]))).rejects.toThrow('not both');
  expect(strategyWorkspace(await requireTask(db, execution.id)).blueprint).toBeUndefined();

  let view = await call('create_strategy_blueprint', blueprint([
    {territory_create_key: 'writing', values: direction('Replies')},
    {territory_create_key: 'writing', values: direction('Follow-ups')},
    {territory_create_key: 'speaking', values: direction('Meetings')},
  ]));
  const saved = view.workspace.blueprint;
  const writing = saved.territories.find((item: any) => item.name === 'Writing');
  const speaking = saved.territories.find((item: any) => item.name === 'Speaking');
  expect(saved.clusters.map((item: any) => [item.name, item.territory_key])).toEqual([['Replies', writing.key], ['Follow-ups', writing.key], ['Meetings', speaking.key]]);
  expect(JSON.stringify(strategyWorkspace(await requireTask(db, execution.id)))).not.toContain('create_key');
  expect(view.draft).toMatchObject({ state: 'has_blueprint', territories: 2, clusters: 3 });

  // Later revisions patch saved draft objects by the refs the draft read returns.
  view = await call('patch_strategy_blueprint', {workspace_ref: view.workspace_ref, blueprint: {}, clusters: [{ref: saved.clusters[2].ref, territory_ref: writing.ref, values: {summary: 'Moved'}}]});
  expect(view.workspace.blueprint.clusters[2]).toMatchObject({ summary: 'Moved', territory_key: writing.key });
  // A storage key is not a draft selector.
  await expect(call('patch_strategy_blueprint', {workspace_ref: view.workspace_ref, blueprint: {}, clusters: [{ref: writing.key, values: {summary: 'Guessed'}}]})).rejects.toThrow('reference');
});
