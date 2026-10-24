// These tests isolate editorial/domain contracts; learning orchestration has its own Runtime acceptance.
vi.mock('../learning/business', async () => { const runtime = await import('./conversation-runtime'); return { runBusinessConversationTask: runtime.runConversationTask }; });
import { expect, it, vi } from 'vitest';
import { editorialFixture } from './content-editorial.test-fixture';
import { saveSlot } from './parameter-slots';
import { beginTaskDecision, setTaskAction } from './task-store';
import { agentDefinition } from './definitions';
import { runContentParentConversation } from './content-parent-conversation';
import { LEGACY_START_ARTICLE_TASKS_DESCRIPTION } from './content-production-tools';
import { runConversationTask } from './conversation-runtime';
import type { AgentModuleExecutionContext } from './agent-modules';
import type { CoveragePlan } from './content-editorial';
import { readRuntimeJson } from './runtime-content';
import { classifyToolFailure } from './tool-failure';

vi.mock('./conversation-runtime', () => ({runConversationTask:vi.fn(async()=>({status:'waiting',output:{}}))}));
vi.mock('../db', () => ({getSiteForWorkspace:async()=>({id:'s',workspace_id:'w'})}));
vi.mock('./child-run-wait', () => ({waitForChildRuns:async()=>[]}));
vi.mock('./content-production',async original=>({...await original<typeof import('./content-production')>(),
  inspectContentProductionGroup:async()=>({group:{id:'g'},items:[{job_id:'j',decision_item_id:'item',artifact_id:'',artifact_status:'',job_status:'queued',attempt:0,parent_review:{},review_note:''}]}),
  loadArticleProductionContext:async()=>[{value:{job_id:'j',previous_artifact_id:''}}],
}));

it.each([21, 22, 23])('preserves the mapped completion report and historical contract for content v%s', async version => {
  const f = await editorialFixture();
  const p = await f.task('parent', 'content_production');
  f.sqlite.exec(`alter table content_production_groups add column updated_at text default '';
    alter table content_production_groups add column status text default 'awaiting_review';
    alter table content_production_groups add column total_items integer default 1;
    alter table content_production_groups add column ready_items integer default 1;
    alter table content_production_groups add column failed_items integer default 0;
    alter table content_production_groups add column error text default '';
    alter table jobs add column status text default 'published';`);
  const run = f.sqlite.prepare('select * from agent_runs where id=?').get('parent') as Record<string, unknown>;
  run.summary_json = JSON.stringify({ group_id: 'g' });
  run.definition_version = version;
  await runContentParentConversation({ env: p.env, run, definition: agentDefinition('content_production'), step: {} } as unknown as AgentModuleExecutionContext);
  const agent = vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent;
  const start = agent.tools(p.task, undefined).resolve(agentDefinition('content_production'), 'start_article_tasks');
  expect(start.description === LEGACY_START_ARTICLE_TASKS_DESCRIPTION).toBe(version <= 22);
  const tool = agent.tools(p.task, undefined).resolve(agentDefinition('content_production'), 'complete_content_group');
  const judgment_summary = 'The assigned scope contains existing published work. No new article was produced; the requested expansion remains unresolved.';
  const output = await tool.execute!({ judgment_summary }, p.context);
  const completion = tool.completion!(output);
  if (!completion) throw new Error('Content completion did not return a checkpoint');
  if (version >= 22) {
    expect(output).toMatchObject({ judgment_summary, outcome: 'completed' });
    expect(completion.outcome).toBe('completed');
    expect(completion.reason).toBe(judgment_summary);
    expect(completion.output).toMatchObject({ judgment_summary });
    expect(tool.version).toBe(3);
  } else {
    expect(output).not.toHaveProperty('judgment_summary');
    expect(completion.outcome).toBe('awaiting_human_review');
    expect(completion.reason).toBe('Articles ready for publication review');
    expect(tool.version).toBe(2);
  }
  expect(f.sqlite.prepare('select status from jobs').get()).toEqual({ status: 'published' });
});

it('binds the explicitly selected plan before dispatch and rejects missing or foreign plans without starting children', async()=>{
  const f=await editorialFixture();const p=await f.task('parent','content_production');
  f.sqlite.exec("alter table content_production_groups add column updated_at text default '';");
  f.sqlite.exec("alter table jobs add column child_run_id text default '';alter table jobs add column status text default 'queued';alter table jobs add column updated_at text default '';alter table jobs add column site_id text default 's';");
  const run=f.sqlite.prepare('select * from agent_runs where id=?').get('parent') as Record<string,unknown>;
  run.summary_json=JSON.stringify({group_id:'g'});run.definition_version=18;
  const started: unknown[]=[];
  const startChildRun=vi.fn(async(value)=>{started.push(value);return {id:value.runId};});
  await runContentParentConversation({env:p.env,run,definition:agentDefinition('content_production'),startChildRun,step:{}} as unknown as AgentModuleExecutionContext);
  const agent=vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent;
  const observation_ref=await saveSlot(p.env.DB,p.task,'content_group',{group:{id:'g'},items:[{job_id:'j',decision_item_id:'item',artifact_id:'',artifact_status:'',job_status:'queued',attempt:0,parent_review:{},review_note:''}]});
  // Exercise the parent's mapped registry, not just the standalone tool factory.
  const save=agent.tools(p.task,undefined).resolve(agentDefinition('content_production'),'save_coverage_plan');
  expect(save.completion).toBeUndefined();
  const saved=await save.execute!(save.inputSchema.parse({observation_ref,job_id:'j',reader_task:'Answer the reader',distinct_value:'Useful examples',requirements:[],judgment_summary:'Plan before assigning'}),p.context) as {coverage_ref:string};
  expect(saved.coverage_ref).toMatch(/^ref-/);
  expect(f.sqlite.prepare("select count(*) as n from agent_parameter_slots where kind='content_coverage'").get()).toEqual({n:1});
  expect(agent.tools(p.task,undefined).resolve(agentDefinition('content_production'),'defer_content_group').completion).toBeTypeOf('function');
  const plan:CoveragePlan={job_id:'j',revision:1,previous_plan_ref:'',reader_task:'Original task',distinct_value:'Original evidence',requirements:[]};
  const selected=await saveSlot(p.env.DB,p.task,'content_coverage',plan);
  await saveSlot(p.env.DB,p.task,'content_coverage',{...plan,revision:2,reader_task:'Newer but unselected'});
  const foreign=await saveSlot(p.env.DB,p.task,'content_coverage',{...plan,job_id:'another-job'});
  const op=await beginTaskDecision(p.env.DB,p.task,{});await setTaskAction(p.env.DB,p.task,op,{name:'start_article_tasks',input:{}});
  const tool=agent.tools(p.task,op).resolve(agentDefinition('content_production'),'start_article_tasks');
  const args={observation_ref,job_ids:['j'],editorial_brief:'Use the original plan',judgment_summary:'Assign',coverage_plans:[{job_id:'j',coverage_ref:selected}]};
  await expect(tool.execute!({...args,coverage_plans:[]},p.context)).rejects.toThrow('exactly one');
  await expect(tool.execute!({...args,coverage_plans:[{job_id:'j',coverage_ref:foreign}]},p.context)).rejects.toThrow('another job');
  expect(startChildRun).not.toHaveBeenCalled();
  await tool.execute!(args,p.context);
  expect(startChildRun).toHaveBeenCalledTimes(1);
  expect(started[0]).toMatchObject({initialAssignment:{subjects:[{type:'job',id:'j',version:null}],material:{editorial_contract_version:2,coverage_plan:plan}}});
  const bound=f.sqlite.prepare('select resolved_json from agent_operation_bindings where operation_id=?').get(op.id) as {resolved_json:string};
  expect(await readRuntimeJson(f.db,bound.resolved_json)).toMatchObject([{material:{coverage_plan:plan}}]);
});

it('rejects a published article as an immutable state conflict before starting an author', async () => {
  const f = await editorialFixture(); const p = await f.task('parent', 'content_production');
  f.sqlite.exec("alter table content_production_groups add column updated_at text default '';alter table jobs add column status text default 'published';alter table jobs add column site_id text default 's';");
  const run = f.sqlite.prepare('select * from agent_runs where id=?').get('parent') as Record<string, unknown>;
  run.summary_json = JSON.stringify({ group_id: 'g' }); run.definition_version = 17;
  const startChildRun = vi.fn();
  await runContentParentConversation({ env: p.env, run, definition: agentDefinition('content_production'), startChildRun, step: {} } as unknown as AgentModuleExecutionContext);
  const agent = vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent;
  const observation_ref = await saveSlot(p.env.DB, p.task, 'content_group', { group: { id: 'g' },
    items: [{ job_id: 'j', decision_item_id: 'item', artifact_id: '', artifact_status: '', job_status: 'published', attempt: 0, parent_review: {}, review_note: '' }] });
  const op = await beginTaskDecision(p.env.DB, p.task, {}); await setTaskAction(p.env.DB, p.task, op, { name: 'start_article_tasks', input: {} });
  const tool = agent.tools(p.task, op).resolve(agentDefinition('content_production'), 'start_article_tasks');
  let failure: unknown;
  try { await tool.execute!({ observation_ref, job_ids: ['j'], editorial_brief: 'Revise', judgment_summary: 'Revise' }, p.context); }
  catch (error) { failure = error; }
  expect(classifyToolFailure(failure)).toMatchObject({ kind: 'state_conflict', effects: 'none', retryable: false });
  expect(String(failure)).toContain('published and cannot be modified');
  expect(startChildRun).not.toHaveBeenCalled();
});
