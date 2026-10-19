import { readLeaderTodo } from './todo';
import { appendLeaderProgressReview } from './progress-review';
// @ts-ignore Node-only fixture
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { taskTestDb, resumeTestTask } from '../agent-runtime/task-test-db';
import { agentDefinition } from '../agent-runtime/definitions';
import { attachTask, beginTaskDecision, taskForRun, stopTask } from '../agent-runtime/task-store';
import { hitlTool } from '../agent-work/hitl-tool';
import { parseHitlSpec } from '../../shared/hitl';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution, currentExecution } from '../agent-runtime/runtime-executions';
import { executionEnvironment } from '../agent-runtime/execution-context';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from '../agent-runtime/env';
import { replayConversationResponse } from '../agent-runtime/conversation-replay';
import { readConversation } from '../agent-runtime/conversation-store';
import { createConversation, enqueueInput, deliverLeaderReport, pendingInputs, readLeaderDetail, settleLeaderCheckpoint, wakeConversation } from './service';
import { runLeaderConversation } from './runtime';
import { discoverableAgents, leaderTools } from './tools';
import { LEADER_COORDINATION_DELEGATE } from './coordination';
import { persistRuntimeJson } from '../agent-runtime/runtime-content';

const model: Model<'openai-completions'> = { id:'test',name:'test',api:'openai-completions',provider:'test',baseUrl:'https://example.invalid',reasoning:false,input:['text'],contextWindow:32000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };
const step = { do: async (_key: string, config: unknown, fn?: () => Promise<unknown>) => (fn || config as () => Promise<unknown>)(), sleep: async () => {}, waitForEvent: async () => { throw new Error('Leader must not wait inside delegation'); } } as unknown as RuntimeWorkflowStep;
function reply(text: string, calls: Array<{id:string;name:string;arguments:Record<string,unknown>}> = []): AssistantMessage {
  return { role:'assistant',content:[...(text?[{type:'text' as const,text}]:[]),...calls.map(c=>({type:'toolCall' as const,...c}))],api:model.api,provider:model.provider,model:model.id,stopReason:calls.length?'toolUse':'stop',timestamp:Date.now(),usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
}
async function fixture(testModel = model) {
  const f = taskTestDb();
  f.sqlite.exec("alter table sites add column workspace_id text default 'w'; alter table sites add column source_locale text default 'en'; alter table sites add column translate_locales_json text default '[]';");
  f.sqlite.exec(readFileSync(new URL('../../migrations/0066_growth_leader.sql',import.meta.url).pathname,'utf8'));
  f.sqlite.exec(readFileSync(new URL('../../migrations/0070_leader_delivery_queues.sql',import.meta.url).pathname,'utf8'));
  const run = f.run('leader','leader');
  f.sqlite.prepare("update agent_runs set agent_id='growth_leader',definition_version=1,prompt_version='growth-leader-v1' where id=?").run(run.id);
  const leaderRun = {...run,agent_id:'growth_leader',definition_version:1,prompt_version:'growth-leader-v1'};
  await attachTask(f.db,leaderRun,agentDefinition('growth_leader'));
  f.sqlite.prepare('update agent_tasks set definition_version=1 where active_run_id=?').run('leader');
  let execution = await createRuntimeExecution(f.db,run.id);
  await activateRuntimeExecution(f.db,authorityForExecution(execution),execution.workflow_id);
  const create = vi.fn(async (options:{id:string})=>({id:options.id}));
  const host = {DB:f.db,AGENT_WORKFLOW:{create},AGENT_RUNTIME_ENABLED:'true'} as unknown as RuntimeAgentEnv;
  const scope = {workspaceId:'w',siteId:'s'};
  await createConversation(host,scope,{id:'leader',title:'Growth'});
  const responses: AssistantMessage[]=[];
  const requests: string[]=[];
  const stream: StreamFn = (m,c,o) => { requests.push(JSON.stringify(c)); const next=responses.shift(); if(!next) throw new Error('Unexpected model request'); return replayConversationResponse(next,stream)(m,c,o); };
  const runTurn=()=>runLeaderConversation({env:executionEnvironment(host,authorityForExecution(execution)),step,runId:'leader',transport:{model:testModel,stream}});
  const resume=async()=>{execution=(await currentExecution(f.db,'leader'))!; await activateRuntimeExecution(f.db,authorityForExecution(execution),execution.workflow_id);};
  return {...f,host,scope,responses,requests,runTurn,resume,create,execution:()=>execution};
}

describe('Growth Leader native Pi conversations',()=>{
  it('starts a scheduled Leader conversation with its durable schedule identity', async () => {
    const f = await fixture();
    await createConversation(f.host, f.scope, { id: 'daily-topics:s:2026-09-26', title: 'Daily topics' });
    await enqueueInput(f.host, f.scope, 'daily-topics:s:2026-09-26', {
      id: 'daily-trigger:s:2026-09-26', kind: 'assignment', actorId: 'daily_trigger', content: 'Start a topic batch',
    });
    await wakeConversation(f.host, f.scope, 'daily-topics:s:2026-09-26', 'daily-trigger:s:2026-09-26');
    const run = await f.db.prepare('select trigger,schedule_key from agent_runs where id=?')
      .bind('daily-topics:s:2026-09-26').first<{trigger:string;schedule_key:string}>();
    expect(run).toEqual({ trigger: 'cron', schedule_key: 'daily-trigger:s:2026-09-26' });
  });

  async function reviewFixture(plan = true) {
    const f = await fixture();
    f.sqlite.exec(`create table agent_pool_events(id text,type text,subject_id text,subject_version text,source_ref text,summary text);
      create table agent_event_deliveries(event_id text,available_at text,status text,target_run_id text,workspace_id text,site_id text,agent_id text);`);
    f.sqlite.prepare('update agent_tasks set definition_version=6,workspace_json=? where id=?')
      .run(JSON.stringify(plan ? { leader_todo: { markdown: '# Goal: two new articles; not verified' } } : {}), 'leader');
    return f;
  }

  it('reviews a premature reply in the same pipeline and permits a corrected todo and waiting outcome', async () => {
    const f = await reviewFixture();
    const observation = await readLeaderTodo(f.host, (await taskForRun(f.db, 'leader'))!);
    f.responses.push(reply('Everything is done.'), reply('', [{ id: 'correct-plan', name: 'write_todo', arguments: {
      observation_ref: observation.observation_ref, markdown: '# Goal: two new articles\nUnfinished; historical results do not prove new production. Waiting for existing specialist.',
    } }]), reply('The original goal remains unfinished; waiting for the specialist.'));
    await f.runTurn();
    expect(f.requests).toHaveLength(3);
    expect(f.requests[1]).toContain('Pre-wait review');
    expect(JSON.parse((await taskForRun(f.db, 'leader'))!.workspace_json).leader_todo.markdown).toContain('Unfinished');
    const detail = await readLeaderDetail(f.host, f.scope, 'leader');
    expect(detail?.messages.some(message => message.text === 'Everything is done.')).toBe(false);
    expect(detail?.messages.some(message => message.text.includes('original goal remains unfinished'))).toBe(true);
    expect((await taskForRun(f.db, 'leader'))?.status).toBe('waiting');
    expect(f.sqlite.prepare('select count(*) n from agent_conversations').get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare("select count(*) n from agent_conversation_messages where message_key like 'leader-progress-closing:%'").get()).toEqual({ n: 1 });
  });

  it('allows unchanged plans and does not repeat a reviewed observation after compaction', async () => {
    const f = await reviewFixture();
    f.responses.push(reply('Waiting.'), reply('The saved waiting condition is still accurate.'));
    await f.runTurn();
    expect(f.requests).toHaveLength(2);
    const tail = f.sqlite.prepare('select max(sequence) n from agent_conversation_messages where task_id=?').get('leader') as { n: number };
    f.sqlite.prepare('insert into agent_conversation_compactions values(?,?,?,?,?,?)')
      .run('leader', 1, tail.n, JSON.stringify('Waiting with the reviewed plan.'), 'test-summary', new Date().toISOString());
    expect(await appendLeaderProgressReview(f.host, (await taskForRun(f.db, 'leader'))!, 'closing')).toBeNull();
  });

  it('reconciles new task results, reviews new evidence again, and replays the final checkpoint without extra calls', async () => {
    const f = await reviewFixture();
    f.responses.push(
      reply('', [{ id: 'read-first', name: 'read_task', arguments: { task_ref: 'leader' } }]),
      reply('Initial assessment.'),
      reply('', [{ id: 'read-next', name: 'read_task', arguments: { task_ref: 'leader' } }]),
      reply('Evidence checked; still waiting.'),
      reply('The saved plan and waiting condition are accurate.'),
    );
    await f.runTurn();
    expect(f.requests).toHaveLength(5);
    expect(f.requests[1]).toContain('Task continuation check');
    expect(f.requests[2]).toContain('Pre-wait review');
    expect(f.sqlite.prepare("select count(*) n from agent_conversation_messages where message_key like 'leader-progress-result:%'").get()).toEqual({ n: 2 });
    expect(f.sqlite.prepare("select count(*) n from agent_conversation_messages where message_key like 'leader-progress-closing:%'").get()).toEqual({ n: 2 });
    f.sqlite.prepare("update agent_tasks set status='running',outcome='' where active_run_id='leader'").run();
    await f.runTurn();
    expect(f.requests).toHaveLength(5);
  });

  it('resumes a persisted closing review after interruption without publishing the draft', async () => {
    const f = await reviewFixture();
    f.responses.push(reply('Unverified completion draft.'));
    await expect(f.runTurn()).rejects.toThrow();
    expect((await readLeaderDetail(f.host, f.scope, 'leader'))?.messages.some(message => message.text === 'Unverified completion draft.')).toBe(false);
    // The transport stub failed before external I/O; use the existing recovery fixture.
    await resumeTestTask(f.db, 'leader');
    await f.resume();
    f.responses.push(reply('Evidence is incomplete; the original goal remains open.'));
    await f.runTurn();
    expect(f.sqlite.prepare("select count(*) n from agent_conversation_messages where message_key like 'leader-progress-closing:%'").get()).toEqual({ n: 1 });
    expect((await readLeaderDetail(f.host, f.scope, 'leader'))?.messages.some(message => message.text.includes('original goal remains open'))).toBe(true);
  });

  it('uses the thin coordination contract for v8 without stacking the earlier execution-review prompts', async () => {
    const f = await reviewFixture();
    f.sqlite.prepare('update agent_tasks set definition_version=8 where id=?').run('leader');
    f.responses.push(reply('Waiting for the responsible member.'), reply('The existing delegation remains in progress.'));
    await f.runTurn();
    const prompt = JSON.parse(f.requests[0]).systemPrompt;
    expect(prompt).toContain('specialist members hold execution responsibility');
    expect(prompt).not.toContain('Cannot subtract the current list count from the count in the old summary');
    expect(prompt).not.toContain('Must use this conversation\'s todo.md to maintain the execution plan');
    expect(f.requests[1]).toContain('Coordination wrap-up');
    expect((await taskForRun(f.db, 'leader'))?.status).toBe('waiting');
    expect(f.requests).toHaveLength(2);
    expect(await appendLeaderProgressReview(f.host, (await taskForRun(f.db, 'leader'))!, 'closing')).toBeNull();
    const manifest = JSON.parse(f.requests[0]).tools;
    expect(manifest.find((tool: { name: string }) => tool.name === 'delegate_task').description).toContain('does not resume an existing task');
    expect(manifest.some((tool: { name: string }) => tool.name === 'find_conversations')).toBe(true);
  });

  it('keeps creator background historical and omits cross-conversation lookup in v9 model requests', async () => {
    const f = await reviewFixture(false);
    f.sqlite.prepare('update agent_tasks set definition_version=9 where id=?').run('leader');
    f.sqlite.prepare('update leader_conversations set context=? where id=?').run('Created only for an old acceptance test', 'leader');
    await enqueueInput(f.host, f.scope, 'leader', { id: 'new-goal', kind: 'user', actorId: 'u', content: 'Produce two new articles' });
    f.responses.push(reply('I will coordinate this request.'));
    await f.runTurn();
    const request = JSON.parse(f.requests[0]);
    expect(request.systemPrompt).toContain('title and creation background only explain why it was created at the time');
    expect(request.tools.some((tool: { name: string }) => tool.name === 'find_conversations')).toBe(false);
    expect(f.requests[0]).toContain('Historical creator-provided conversation background');
    expect(f.requests[0]).toContain('Current direct user request in this conversation');
    expect(f.requests[0]).toContain('Produce two new articles');
    expect(request.systemPrompt).toContain('only jobs that currently exist and belong to the corresponding production group');
    expect((f.sqlite.prepare('select instructions from agent_conversations where task_id=?').get('leader') as { instructions: string }).instructions).not.toContain('only jobs that currently exist and belong to the corresponding production group');
    await settleLeaderCheckpoint(f.host, authorityForExecution(f.execution()));
    await enqueueInput(f.host, f.scope, 'leader', { id: 'followup-goal', kind: 'user', actorId: 'u', content: 'Continue the two articles' });
    await wakeConversation(f.host, f.scope, 'leader');
    await f.resume();
    f.responses.push(reply('I will check the current jobs.'));
    await f.runTurn();
    expect(JSON.parse(f.requests.at(-1)!).systemPrompt.match(/only jobs that currently exist and belong to the corresponding production group/g)).toHaveLength(1);
  });

  it('puts the production handoff contract in new Leader instructions without an extra legacy message', async () => {
    const f = await reviewFixture(false);
    f.sqlite.prepare('update agent_tasks set definition_version=10 where id=?').run('leader');
    f.responses.push(reply('I will inspect the current work.'));
    await f.runTurn();
    const request = JSON.parse(f.requests[0]);
    expect(request.systemPrompt).toContain('only jobs that currently exist and belong to the corresponding production group');
    expect(request.systemPrompt).toContain('Editor-in-Chief content_production is responsible for the writing, review, rework');
    expect(request.systemPrompt).toContain('Delegation acceptance only means taking on the task');
    expect(request.systemPrompt.match(/only jobs that currently exist and belong to the corresponding production group/g)).toHaveLength(1);
  });

  it('includes system language and publication evidence boundaries in new Leader requests', async () => {
    const f = await reviewFixture(false);
    f.sqlite.prepare('update agent_tasks set definition_version=17 where id=?').run('leader');
    f.responses.push(reply('I will check the owner constraints and manuscript.'));
    await f.runTurn();
    const request = JSON.parse(f.requests[0]);
    expect(request.systemPrompt).toContain('system language en (English)');
    expect(request.systemPrompt).toContain('Article bodies, market research terms and exact source quotations keep their assigned language');
    expect(request.systemPrompt).toContain('use read_workspace business');
    expect(request.systemPrompt).toContain('it does not establish that an owner-required review has happened');
    expect(request.systemPrompt).toContain('A configured product URL is a destination, not evidence');
  });

  it('sends general clarification guidance and its existing human-input capability in the new Leader request', async () => {
    const f = await reviewFixture(false);
    f.sqlite.prepare('update agent_tasks set definition_version=11 where id=?').run('leader');
    f.responses.push(reply('I will clarify the unresolved objective.'));
    await f.runTurn();
    const request = JSON.parse(f.requests[0]);
    expect(request.systemPrompt).toContain('When facing any unclear information');
    expect(request.systemPrompt).toContain('not limited to certain types of fields');
    expect(request.systemPrompt).toContain('do not bake speculation into delegations');
    expect(f.requests[0]).toContain('request_human_input');
    expect((f.sqlite.prepare('select instructions from agent_conversations where task_id=?').get('leader') as { instructions: string }).instructions).toContain('When facing any unclear information');
  });

  it('initializes the evidence environment only for the new Leader contract', async () => {
    const f = await reviewFixture(false);
    f.sqlite.prepare('update agent_tasks set definition_version=7 where id=?').run('leader');
    f.responses.push(reply('Ready to help.'));
    await f.runTurn();
    expect(JSON.parse(f.requests[0]).systemPrompt).toContain('Reading time differs in meaning from creation, modification, and publication times');
    expect(JSON.parse(f.requests[0]).tools.find((tool: { name: string }) => tool.name === 'read_workspace').parameters.properties.section.enum).toContain('topic_groups');
  });

  it('does not add a closing model call for discussion without a plan or delegation', async () => {
    const f = await reviewFixture(false);
    f.responses.push(reply('Here is how the team works.'));
    await f.runTurn();
    expect(f.requests).toHaveLength(1);
  });

  it('persists todo through the real tool executor and restores it on a child-report resume', async () => {
    const f = await fixture();
    f.sqlite.exec(`create table agent_pool_events(id text,type text,subject_id text,subject_version text,source_ref text,summary text);
      create table agent_event_deliveries(event_id text,available_at text,status text,target_run_id text,workspace_id text,site_id text,agent_id text);`);
    f.sqlite.prepare('update agent_tasks set definition_version=5 where id=?').run('leader');
    const task = (await taskForRun(f.db, 'leader'))!;
    const observation = await readLeaderTodo(f.host, task);
    f.responses.push(reply('', [{ id: 'todo-write', name: 'write_todo', arguments: {
      observation_ref: observation.observation_ref, markdown: '# Goal\n- [ ] Produce new work; awaiting specialist report',
    } }]), reply('Waiting for specialist.'));
    await f.runTurn();
    expect(f.requests.at(-1)).toContain('Produce new work; awaiting specialist report');
    const tail = f.sqlite.prepare('select max(sequence) n from agent_conversation_messages where task_id=?').get('leader') as { n: number };
    f.sqlite.prepare('insert into agent_conversation_compactions values(?,?,?,?,?,?)')
      .run('leader', 1, tail.n, JSON.stringify('Earlier discussion archived; waiting for a team report.'), 'test-summary', new Date().toISOString());
    await settleLeaderCheckpoint(f.host, authorityForExecution(f.execution()));
    await enqueueInput(f.host, f.scope, 'leader', { id: 'child-return', kind: 'child_report', actorId: 'system', content: 'Only old artifacts were found' });
    await wakeConversation(f.host, f.scope, 'leader');
    await f.resume();
    f.responses.push(reply('The new work remains outstanding.'));
    await f.runTurn();
    expect(f.requests.at(-1)).toContain('Only old artifacts were found');
    expect(f.requests.at(-1)).toContain('Produce new work; awaiting specialist report');
    expect(f.sqlite.prepare('select count(*) n from agent_conversations').get()).toEqual({ n: 1 });
  });

  it('returns scoped group details and work timestamps without inferring goal completion', async () => {
    const f = await fixture();
    f.sqlite.exec(`
      create table content_production_groups(id text,workspace_id text,site_id text,decision_group_id text,status text,total_items integer,ready_items integer,failed_items integer,created_at text,updated_at text);
      create table topic_decision_items(id text,title_direction text,primary_keyword text,group_role text,sort_order integer);
      create table jobs(id text,site_id text,production_group_id text,decision_item_id text,status text,created_at text,published_at text,current_artifact_id text);
      insert into content_production_groups values('group','w','s','decision','awaiting_review',1,1,0,'2026-09-17','2026-09-24');
      insert into topic_decision_items values('item','Existing article','keyword','anchor',0);
      insert into jobs values('job','s','group','item','published','2026-09-17','2026-09-17','artifact');
    `);
    const task = (await taskForRun(f.db, 'leader'))!;
    const context = { runId: 'leader', workspaceId: 'w', siteId: 's', idempotencyKey: 'read' };
    const read = (version: number) => leaderTools(f.host, step, { ...task, definition_version: version })
      .resolve(agentDefinition('growth_leader'), 'read_workspace');
    const args = { section: 'content_groups', target_ref: 'group', offset: 0 };
    expect(await read(4).execute!(args, context)).toMatchObject({
      group: { target_ref: 'group', status: 'awaiting_review' },
      items: [{ job_ref: 'job', status: 'published', published_at: '2026-09-17' }],
    });
    expect(await read(7).execute!(args, context)).toMatchObject({ observation: { kind: 'workspace_records' }, data: { group: { target_ref: 'group' }, items: [{ published_at: '2026-09-17' }] } });
    expect(await read(3).execute!(args, context)).toEqual([{ target_ref: 'group', decision_group_id: 'decision', status: 'awaiting_review' }]);
    f.sqlite.exec("update content_production_groups set site_id='other-site'");
    await expect(read(4).execute!(args, context)).rejects.toThrow('Content group not found');
  });

  it('limits overview task rows to this conversation and its direct delegations', async () => {
    const f = await fixture();
    f.sqlite.exec(`alter table sites add column name text default 'Site';
      alter table sites add column domain text default '';
      alter table sites add column root_domain text default '';
      alter table sites add column product_brief text default '';
      create table business_module_versions(site_id text,module_key text,version integer);
      create table seo_strategy_runs(id text,site_id text,source_locale text,status text,started_at text);`);
    const child = f.run('owned-child', 'owned-child');
    await attachTask(f.db, child, agentDefinition('runtime_synthetic'));
    f.sqlite.prepare('update agent_tasks set parent_task_id=? where id=?').run('leader', child.id);
    const unrelated = f.run('another-conversation-task', 'another-conversation-task');
    await attachTask(f.db, unrelated, agentDefinition('runtime_synthetic'));
    const task = (await taskForRun(f.db, 'leader'))!;
    const read = leaderTools(f.host, step, { ...task, definition_version: 9 })
      .resolve(agentDefinition('growth_leader'), 'read_workspace');
    const result = await read.execute!({ section: 'overview', offset: 0 }, { runId: 'leader', workspaceId: 'w', siteId: 's', idempotencyKey: 'overview' }) as { data: { tasks: Array<{ task_ref: string }> } };
    expect(result.data.tasks.map(row => row.task_ref)).toEqual(expect.arrayContaining(['leader', child.id]));
    expect(result.data.tasks.map(row => row.task_ref)).not.toContain(unrelated.id);
  });
  it('pins continuity instructions for new conversations without applying them to legacy conversations', async () => {
    const old = await fixture();
    old.responses.push(reply('Ready.'));
    await old.runTurn();
    expect(JSON.parse(old.requests[0]).systemPrompt).not.toContain('Continuously take on the work the user assigns to you');
    const fresh = await fixture();
    fresh.sqlite.exec(`create table agent_pool_events(id text,type text,subject_id text,subject_version text,source_ref text,summary text);
      create table agent_event_deliveries(event_id text,available_at text,status text,target_run_id text,workspace_id text,site_id text,agent_id text);`);
    fresh.sqlite.prepare('update agent_tasks set definition_version=4 where id=?').run('leader');
    fresh.responses.push(reply('Ready.'));
    await fresh.runTurn();
    expect(JSON.parse(fresh.requests[0]).systemPrompt).toContain('Continuously take on the work the user assigns to you');
    const instructions = fresh.sqlite.prepare('select instructions from agent_conversations where task_id=?').get('leader');
    await settleLeaderCheckpoint(fresh.host, authorityForExecution(fresh.execution()));
    await enqueueInput(fresh.host, fresh.scope, 'leader', { id: 'next', kind: 'user', actorId: 'u', content: 'Continue the original work' });
    await wakeConversation(fresh.host, fresh.scope, 'leader');
    await fresh.resume();
    fresh.responses.push(reply('Continuing.'));
    await fresh.runTurn();
    expect(fresh.sqlite.prepare('select instructions from agent_conversations where task_id=?').get('leader')).toEqual(instructions);
    expect(fresh.sqlite.prepare('select count(*) n from agent_conversations').get()).toEqual({ n: 1 });
    const input = fresh.sqlite.prepare('select created_at from leader_inputs where id=?').get('next') as { created_at: string };
    expect(fresh.requests.at(-1)).toContain('received_at');
    expect(fresh.requests.at(-1)).toContain(input.created_at);
    expect(fresh.requests.at(-1)).toContain('Continue the original work');
    expect((await readLeaderDetail(fresh.host, fresh.scope, 'leader'))!.messages.find(message => message.id === 'next')?.text)
      .toBe('Continue the original work');
  });

  it('returns the saved assignment with its report only in the new contract, including chunked material', async () => {
    const f = await fixture();
    const run = f.run('reported-child', 'reported-child');
    await attachTask(f.db, run, agentDefinition('runtime_synthetic'));
    const material = { goal: 'Produce the next batch', reason: 'Expand coverage', context: 'Evidence '.repeat(8000) };
    const stored = await persistRuntimeJson(f.db, material);
    f.sqlite.prepare('insert into agent_task_assignments(id,task_id,operation_id,context_json,created_at) values(?,?,?,?,?)')
      .run('assignment-child', run.id, 'assignment-child', stored, '2026-09-24T12:00:00Z');
    f.sqlite.prepare('update agent_tasks set assignment_id=?,output_json=? where id=?')
      .run('assignment-child', JSON.stringify({ judgment_summary: 'Only existing work was found' }), run.id);
    f.sqlite.prepare('update agent_tasks set parent_task_id=? where id=?').run('leader', run.id);
    const task = (await taskForRun(f.db, 'leader'))!;
    const context = { runId: 'leader', workspaceId: 'w', siteId: 's', idempotencyKey: 'read' };
    const read = (version: number) => leaderTools(f.host, step, { ...task, definition_version: version })
      .resolve(agentDefinition('growth_leader'), 'read_task');
    const result = await read(4).execute!({ task_ref: run.id }, context);
    expect(result).toMatchObject({ assignment: { id: 'assignment-child', material }, result: { judgment_summary: 'Only existing work was found' } });
    expect(await read(7).execute!({ task_ref: run.id }, context)).toMatchObject({ observation: { kind: 'task_report' }, data: { assignment: { material }, result: { judgment_summary: 'Only existing work was found' } } });
    expect(await read(3).execute!({ task_ref: run.id }, context)).not.toHaveProperty('assignment');
    const output = { outcome: 'completed', state: { group: { id: 'group' }, items: [{ job_id: 'old-article',
      published_at: '2026-09-17', parent_review: { evidence_findings: ['historical-review'] } }] } };
    f.sqlite.prepare('update agent_tasks set agent_id=?,output_json=? where id=?')
      .run('content_production', JSON.stringify(output), run.id);
    const v8 = await read(8).execute!({ task_ref: run.id }, context);
    expect(v8).toMatchObject({ data: { assignment: { material }, result: {
      artifact_observations: [{ job_id: 'old-article', published_at: '2026-09-17' }],
    } } });
    expect(JSON.stringify(v8)).not.toContain('historical-review');
    expect(await read(7).execute!({ task_ref: run.id }, context)).toMatchObject({ data: { result: output } });

    const unrelated = f.run('unrelated-task', 'unrelated-task');
    await attachTask(f.db, unrelated, agentDefinition('runtime_synthetic'));
    await expect(read(8).execute!({ task_ref: unrelated.id }, context)).rejects.toThrow('Task not found in this conversation');

    f.sqlite.prepare('update agent_tasks set site_id=? where id=?').run('other-site', run.id);
    await expect(read(4).execute!({ task_ref: run.id }, context)).rejects.toThrow('Task not found');
  });

  it('denies old cross-conversation lookup while keeping its pinned tool definition', async () => {
    const f = await fixture();
    const task = (await taskForRun(f.db, 'leader'))!;
    const oldTool = leaderTools(f.host, step, { ...task, definition_version: 8 }).resolve(agentDefinition('growth_leader'), 'find_conversations');
    expect(oldTool.description).toBe('Find this site’s Leader conversations or open one. Specialist internal conversations are not exposed.');
    await expect(oldTool.execute!({ query: '', conversation_ref: 'another-conversation' }, { runId: 'leader', workspaceId: 'w', siteId: 's', idempotencyKey: 'read' }))
      .rejects.toThrow('Reading other Leader conversations is no longer available');
    expect(leaderTools(f.host, step, { ...task, definition_version: 9 }).names()).not.toContain('find_conversations');
  });

  it('includes a composed request in the conversation detail for a new Leader task', async () => {
    const f = await fixture();
    f.sqlite.prepare('update agent_tasks set definition_version=2 where id=?').run('leader');
    const task = (await taskForRun(f.db, 'leader'))!;
    const operation = await beginTaskDecision(f.db, task, {});
    const spec = parseHitlSpec({ schema_version: 1, title: 'Confirm the business goal', blocks: [{ type: 'textarea', id: 'goal', label: 'Goal', max_length: 500 }],
      actions: [{ id: 'send', label: 'Submit', required_fields: ['goal'] }] });
    await hitlTool(f.host, task, operation).execute!({ spec, resume_when: 'Continue after receiving the goal' },
      { runId: 'leader', workspaceId: 'w', siteId: 's', idempotencyKey: operation.id });
    await stopTask(f.db, 'leader', 'waiting', 'Wait for a response');
    const detail = await readLeaderDetail(f.host, f.scope, 'leader');
    expect(detail?.hitl_requests).toMatchObject([{ title: 'Confirm the business goal', interaction: { spec } }]);
  });
  it('reads a submitted HITL response into the same Leader conversation', async () => {
    const f = await fixture();
    const response = JSON.stringify({ type: 'hitl_response', request_id: 'hitl:one', version: '1', action: 'send', values: { goal: 'Improve customer acquisition' } });
    f.sqlite.prepare('insert into agent_task_inputs(id,task_id,actor_id,content,created_at) values(?,?,?,?,?)')
      .run('hitl-one', 'leader', 'user-1', response, new Date().toISOString());
    f.responses.push(reply('I will continue with this goal.'));
    await f.runTurn();
    expect(f.requests[0]).toContain('Improve customer acquisition');
    expect((await readLeaderDetail(f.host, f.scope, 'leader'))?.messages).toContainEqual(expect.objectContaining({ role: 'user', text: 'goal: Improve customer acquisition' }));
  });
  it('answers naturally once, preserves the Run, and appends a later user message',async()=>{
    const f=await fixture();
    await enqueueInput(f.host,f.scope,'leader',{id:'m1',kind:'user',actorId:'u',content:'Discuss our customers'});
    f.responses.push(reply('Let us discuss the customer needs.'));
    await f.runTurn();
    expect(f.requests).toHaveLength(1);
    expect(await taskForRun(f.db,'leader')).toMatchObject({status:'waiting',outcome:'leader_ready'});
    await settleLeaderCheckpoint(f.host,authorityForExecution(f.execution()));
    await enqueueInput(f.host,f.scope,'leader',{id:'m2',kind:'user',actorId:'u',content:'Focus on enterprise customers'});
    await wakeConversation(f.host,f.scope,'leader'); await f.resume();
    f.responses.push(reply('Enterprise customers need a clearer value proposition.'));
    await f.runTurn();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]).toContain('Discuss our customers');
    expect(f.requests[1]).toContain('Focus on enterprise');
    expect(await f.db.prepare('select count(*) n from agent_runs').first()).toEqual({n:1});
    const detail=await readLeaderDetail(f.host,f.scope,'leader');
    expect(detail?.messages.filter(m=>m.role==='assistant')).toHaveLength(2);
  });
  it('discovers actual callable members and excludes protected internal children',()=>{
    expect(discoverableAgents().map(a=>a.agent_ref)).toEqual(expect.arrayContaining(['strategy_research','topic_decision','deep_research','content_production']));
    expect(discoverableAgents().map(a=>a.agent_ref)).not.toContain('article_production');
    expect(discoverableAgents().map(a=>a.agent_ref)).not.toContain('runtime_synthetic');
    expect(discoverableAgents(8).find(a => a.agent_ref === 'content_production')?.input_and_result).toContain('Cannot allocate jobs');
    expect(discoverableAgents(7).find(a => a.agent_ref === 'content_production')?.input_and_result).not.toContain('Cannot allocate jobs');
  });
  it('keeps the pinned v14 delegation manifest while explaining reference slots to new conversations', async () => {
    const f = await fixture();
    const original = (await taskForRun(f.db, 'leader'))!;
    const v14 = leaderTools(f.host, step, { ...original, definition_version: 14 }).resolve(agentDefinition('growth_leader'), 'delegate_task');
    const v15 = leaderTools(f.host, step, { ...original, definition_version: 15 }).resolve(agentDefinition('growth_leader'), 'delegate_task');
    expect(v14.version).toBe(3);
    expect(v14.description).toBe(LEADER_COORDINATION_DELEGATE);
    expect(v15.version).toBe(4);
    expect(v15.description).toContain('top-level scope_ref argument');
    expect(discoverableAgents(15).find(agent => agent.agent_ref === 'topic_decision')?.input_and_result)
      .toContain('delegate_task.scope_ref');
    await expect(v14.execute!({ agent_ref: 'topic_decision', goal: 'Plan topics', reason: 'Daily schedule',
      context: 'scope_ref: ref-mentioned-only-in-prose' }, { runId: 'leader', workspaceId: 'w', siteId: 's', idempotencyKey: 'missing-scope' }))
      .rejects.toMatchObject({ details: { kind: 'invalid_request', effects: 'none',
        issues: [{ path: ['scope_ref'] }] } });
    expect(f.sqlite.prepare("select count(*) n from agent_tasks where parent_task_id='leader'").get()).toEqual({ n: 0 });
  });
  it.each([1, 8])('uses the real scoped child start and returns to the same conversation once (v%s)',async(version)=>{
    const f=await fixture();
    if (version >= 8) {
      f.sqlite.exec("create table jobs(id text,site_id text,status text,current_artifact_id text,production_group_id text,en_title text)");
      f.sqlite.exec(readFileSync(new URL('../../migrations/0074_agent_event_pool.sql', import.meta.url).pathname, 'utf8'));
      f.sqlite.prepare('update agent_tasks set definition_version=? where id=?').run(version, 'leader');
    }
    await enqueueInput(f.host,f.scope,'leader',{id:'m1',kind:'user',actorId:'u',content:'Research customers'});
    // Discovery obtains host-bound language references before the model chooses one.
    const {saveSlot}=await import('../agent-runtime/parameter-slots');
    const task=(await taskForRun(f.db,'leader'))!;
    const ref=await saveSlot(f.db,task,'leader_scope',{locale:'en'});
    f.responses.push(reply('',[{id:'delegate',name:'delegate_task',arguments:{agent_ref:'deep_research',scope_ref:ref,goal:'Research public enterprise customer needs',reason:'Inform positioning',context:''}}]),reply('Research is underway.'));
    if (version >= 8) f.responses.push(reply('Waiting for the delegated research.'));
    await f.runTurn();
    const child=await f.db.prepare("select * from agent_tasks where parent_task_id=?").bind(task.id).first<{id:string;active_run_id:string;execution_id:string}>();
    expect(child).toBeTruthy();
    expect(child!.active_run_id).not.toBe('leader');
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(await pendingInputs(f.host,'leader')).toEqual([]);
    await settleLeaderCheckpoint(f.host,authorityForExecution(f.execution()));
    await stopTask(f.db,child!.active_run_id,'completed','Evidence gathered','completed',{findings:['Needs procurement evidence']});
    await deliverLeaderReport(f.host,child!.active_run_id);
    await deliverLeaderReport(f.host,child!.active_run_id);
    if (version >= 8) {
      expect(f.sqlite.prepare("select target_run_id from agent_event_deliveries where agent_id='growth_leader'").all()).toEqual([{ target_run_id: 'leader' }]);
      f.responses.push(reply('', [{ id: 'read-delivery', name: 'read_task', arguments: { task_ref: child!.id } }]));
    } else expect(await pendingInputs(f.host,'leader')).toHaveLength(1);
    await f.resume(); f.responses.push(reply('The research found procurement concerns.'));
    if (version >= 8) f.responses.push(reply('The research delivery covers the requested question.'));
    await f.runTurn();
    expect(f.requests.at(-1)).toContain('Needs procurement evidence');
    expect(await f.db.prepare('select count(*) n from leader_conversations').first()).toEqual({n:1});
    expect((await readConversation(f.db,(await taskForRun(f.db,'leader'))!))?.messages.filter(m=>m.key.startsWith(version >= 8 ? 'event:task-report:' : 'leader-input:report:'))).toHaveLength(1);
  });
  it('presents the conversation in reading order with delegated work, reports and unread input',async()=>{
    const f=await fixture();
    for (const file of ['0061_team_status_seen','0062_team_status_receipts']) f.sqlite.exec(readFileSync(new URL(`../../migrations/${file}.sql`,import.meta.url).pathname,'utf8'));
    await enqueueInput(f.host,f.scope,'leader',{id:'m1',kind:'user',actorId:'u',content:'Research customers'});
    const {saveSlot}=await import('../agent-runtime/parameter-slots');
    const task=(await taskForRun(f.db,'leader'))!;
    const ref=await saveSlot(f.db,task,'leader_scope',{locale:'en'});
    f.responses.push(reply('',[{id:'delegate',name:'delegate_task',arguments:{agent_ref:'deep_research',scope_ref:ref,goal:'Research enterprise needs',reason:'Inform positioning',context:''}}]),reply('Research is underway.'));
    await f.runTurn();
    await settleLeaderCheckpoint(f.host,authorityForExecution(f.execution()));
    const child=(await f.db.prepare('select id,active_run_id from agent_tasks where parent_task_id=?').bind(task.id).first<{id:string;active_run_id:string}>())!;
    // Queued before the child finishes: still unread, so it must not appear above earlier replies.
    await enqueueInput(f.host,f.scope,'leader',{id:'m2',kind:'user',actorId:'u',content:'Also check pricing'});
    const running=(await readLeaderDetail(f.host,f.scope,'leader'))!;
    expect(running.messages.map(m=>[m.role,m.pending??false])).toEqual([['user',false],['task',false],['assistant',false],['user',true]]);
    expect(running.tasks[0]).toMatchObject({id:child.id,goal:'Research enterprise needs',why:'Inform positioning',attention_count:0});
    expect(running.tasks[0].display_title).toContain('Research enterprise needs');
    const {listConversations}=await import('./service');
    expect((await listConversations(f.host,f.scope))[0]).toMatchObject({preview:'Research customers',team_active:1,team_total:1,team_delivered:0,pending_inputs:1});
    await stopTask(f.db,child.active_run_id,'completed','Evidence gathered','completed',{findings:['x']});
    await deliverLeaderReport(f.host,child.active_run_id);
    const report=(await readLeaderDetail(f.host,f.scope,'leader'))!.messages.find(m=>m.role==='report');
    expect(report).toMatchObject({task_id:child.id,summary:'Evidence gathered',pending:true});
    expect((await listConversations(f.host,f.scope))[0]).toMatchObject({team_active:0,team_total:1,team_delivered:1});
  });
  it('keeps undelivered work in queues so recovery reads only the backlog', async()=>{
    const f=await fixture();
    const {recoverLeaderDeliveries}=await import('./service');
    await enqueueInput(f.host,f.scope,'leader',{id:'m1',kind:'user',actorId:'u',content:'Research customers'});
    expect(f.sqlite.prepare("select read_at from leader_inputs where id='m1'").get()).toEqual({read_at:null});
    const {saveSlot}=await import('../agent-runtime/parameter-slots');
    const task=(await taskForRun(f.db,'leader'))!;
    const ref=await saveSlot(f.db,task,'leader_scope',{locale:'en'});
    f.responses.push(reply('',[{id:'delegate',name:'delegate_task',arguments:{agent_ref:'deep_research',scope_ref:ref,goal:'Research needs',reason:'Positioning',context:''}}]),reply('Underway.'));
    await f.runTurn();
    // The Leader read the input: the trigger marked it, so recovery and live views no longer see it as pending.
    expect((f.sqlite.prepare("select read_at from leader_inputs where id='m1'").get() as {read_at:string|null}).read_at).not.toBeNull();
    expect(await pendingInputs(f.host,'leader')).toEqual([]);
    await settleLeaderCheckpoint(f.host,authorityForExecution(f.execution()));
    const child=(await f.db.prepare('select id,active_run_id from agent_tasks where parent_task_id=?').bind(task.id).first<{id:string;active_run_id:string}>())!;
    expect(f.sqlite.prepare('select count(*) n from leader_report_outbox').get()).toEqual({n:0});
    await stopTask(f.db,child.active_run_id,'completed','Evidence gathered','completed',{findings:['x']});
    // A finished child is queued for reporting; recovery delivers it once and empties the queue.
    expect(f.sqlite.prepare('select child_task_id from leader_report_outbox').all()).toEqual([{child_task_id:child.id}]);
    await recoverLeaderDeliveries(f.host);
    expect(f.sqlite.prepare('select count(*) n from leader_report_outbox').get()).toEqual({n:0});
    expect(await pendingInputs(f.host,'leader')).toHaveLength(1);
    await recoverLeaderDeliveries(f.host);
    expect(f.sqlite.prepare("select count(*) n from leader_inputs where kind='child_report'").get()).toEqual({n:1});
  });
  it('deduplicates messages and rejects identity reuse or cross-site delivery',async()=>{
    const f=await fixture(); const msg={id:'m1',kind:'user' as const,actorId:'u',content:'Hello'};
    await enqueueInput(f.host,f.scope,'leader',msg); await enqueueInput(f.host,f.scope,'leader',msg);
    expect(await pendingInputs(f.host,'leader')).toHaveLength(1);
    await expect(enqueueInput(f.host,f.scope,'leader',{...msg,content:'Changed'})).rejects.toThrow('conflicts');
    await expect(enqueueInput(f.host,{workspaceId:'other',siteId:'s'},'leader',msg)).rejects.toThrow('not found');
  });
  it('recovers a committed final reply without calling the model again',async()=>{
    const f=await fixture();
    await enqueueInput(f.host,f.scope,'leader',{id:'m1',kind:'user',actorId:'u',content:'Hello'});
    f.responses.push(reply('Hello!')); await f.runTurn();
    f.sqlite.prepare("update agent_tasks set status='running',outcome='' where active_run_id='leader'").run();
    await f.runTurn();
    expect(f.requests).toHaveLength(1);
  });
  it('keeps queued input until the next execution and isolates a second conversation',async()=>{
    const f=await fixture();
    await createConversation(f.host,f.scope,{id:'other',title:'Other topic'});
    await enqueueInput(f.host,f.scope,'other',{id:'other-message',kind:'user',actorId:'u',content:'Private second topic'});
    await enqueueInput(f.host,f.scope,'leader',{id:'first',kind:'user',actorId:'u',content:'First topic'});
    f.responses.push(reply('First answer'));
    await f.runTurn();
    // Arrives in the gap between final message persistence and controller projection.
    await enqueueInput(f.host,f.scope,'leader',{id:'queued',kind:'user',actorId:'u',content:'Follow up'});
    await settleLeaderCheckpoint(f.host,authorityForExecution(f.execution()));
    await f.resume(); f.responses.push(reply('Follow-up answer')); await f.runTurn();
    expect(f.requests.at(-1)).toContain('Follow up');
    expect(f.requests.join('')).not.toContain('Private second topic');
    expect(await pendingInputs(f.host,'other')).toHaveLength(1);
    expect(await pendingInputs(f.host,'leader')).toHaveLength(0);
  });
  it('persists semantic compaction without losing the original user message',async()=>{
    const f=await fixture({...model,contextWindow:6000,maxTokens:1000});
    const original='Original business evidence. '.repeat(700);
    await enqueueInput(f.host,f.scope,'leader',{id:'long',kind:'user',actorId:'u',content:original});
    f.responses.push(...Array.from({length:12},()=>reply('Business evidence concerns enterprise buyers. Preserve the original input reference long.')));
    await f.runTurn();
    expect(await f.db.prepare('select count(*) n from agent_conversation_compactions').first()).toEqual({n:1});
    expect(await f.db.prepare("select content from leader_inputs where id='long'").first()).toEqual({content:original});
    expect((await taskForRun(f.db,'leader'))?.status).toBe('waiting');
  });

  it('runs autonomous audits inside the same Pi loop without treating an audit comment as a user reply',async()=>{
    const f=await fixture();
    await enqueueInput(f.host,f.scope,'leader',{id:'a',kind:'user',actorId:'u',content:'Hello'});
    f.responses.push(reply('Hello')); await f.runTurn();
    f.sqlite.prepare("update agent_conversations set normal_decisions=30").run();
    await settleLeaderCheckpoint(f.host,authorityForExecution(f.execution()));
    await enqueueInput(f.host,f.scope,'leader',{id:'b',kind:'user',actorId:'u',content:'Continue our discussion'});
    await wakeConversation(f.host,f.scope,'leader'); await f.resume();
    f.responses.push(reply('I will consider progress.'),reply('',[{id:'audit',name:'resolve_execution_audit',arguments:{decision:'continue',reason:'New user request',progress:'Prior discussion saved',remaining_work:'Answer the new question',next_stage_method:'Use the available context',outcome:'partial',artifact_refs:[],unresolved_issues:[]}}]),reply('Let us continue.'));
    await f.runTurn();
    expect(f.requests).toHaveLength(4);
    expect(await f.db.prepare("select status from agent_runtime_audits where number=1").first()).toEqual({status:'continued'});
    expect((await readLeaderDetail(f.host,f.scope,'leader'))!.messages.some(m=>m.text==='I will consider progress.')).toBe(false);
  });

  it('records user-sourced business facts with an observed document version and preserves later edits',async()=>{
    const f=await fixture();
    for(const name of ['0013_business_modules.sql','0014_business_module_markdown.sql']) f.sqlite.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url).pathname,'utf8'));
    const {saveSlot}=await import('../agent-runtime/parameter-slots');
    const task=(await taskForRun(f.db,'leader'))!;
    const ref=await saveSlot(f.db,task,'leader_document',{key:'product',version:0});
    await enqueueInput(f.host,f.scope,'leader',{id:'fact',kind:'user',actorId:'u',content:'Our main product is an enterprise translation service.'});
    const args={document_ref:ref,markdown:'# Product\nEnterprise translation services',source_refs:[],user_message_refs:['fact']};
    f.responses.push(reply('',[{id:'save',name:'update_business_document',arguments:args}]),reply('Business information saved.'));
    await f.runTurn();
    const row=await f.db.prepare('select version,markdown,source from business_module_versions').first<{version:number;markdown:string;source:string}>();
    expect(row).toMatchObject({version:1,source:'growth_leader'}); expect(row!.markdown).toContain('User message fact');
    await settleLeaderCheckpoint(f.host,authorityForExecution(f.execution()));
    await enqueueInput(f.host,f.scope,'leader',{id:'next',kind:'user',actorId:'u',content:'Check the document'});
    await wakeConversation(f.host,f.scope,'leader'); await f.resume();
    f.responses.push(reply('',[{id:'stale',name:'update_business_document',arguments:{...args,markdown:'Stale overwrite'}}]),reply('The document changed; I need to reread it.'));
    await f.runTurn();
    expect(await f.db.prepare('select count(*) n from business_module_versions').first()).toEqual({n:1});
    expect(f.requests.at(-1)).toContain('Document changed after observation');
  });
  it('leaves delegated topic research needs with the parent while retaining standalone research dispatch',async()=>{
    const f=await fixture();
    f.sqlite.exec("create table topic_decision_results(id text,workspace_id text,site_id text,run_id text,rationale text,research_request_json text,scope_locale text,scope_market text,status text,research_run_id text,research_dispatch_error text,created_at text)");
    const {undispatchedTopicResearchRequests}=await import('../agent-runtime/topic-decision-store');
    const childRun=f.run('topic-child','topic-child');
    const child=await attachTask(f.db,childRun,agentDefinition('strategy_research'));
    f.sqlite.prepare("update agent_tasks set parent_task_id='leader' where id=?").run(child.id);
    for(const [id,run] of [['standalone','standalone-run'],['delegated','topic-child']]) f.sqlite.prepare("insert into topic_decision_results values(?,'w','s',?,'Need evidence','{}','en','US','research_needed','','','2026-09-21')").run(id,run);
    expect((await undispatchedTopicResearchRequests(f.db)).map(r=>r.id)).toEqual(['standalone']);
  });

});
