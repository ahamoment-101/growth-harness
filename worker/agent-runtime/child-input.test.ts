import { expect, it, vi } from 'vitest';
vi.mock('agents', () => ({ getAgentByName: vi.fn() }));
import { taskTestDb } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, beginTaskDecision, requireTask, stopTask, taskForRun } from './task-store';
import { executionEnvironment } from './execution-context';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution, currentExecution } from './runtime-executions';
import { startRuntimeRun } from './run-service';
import type { RuntimeAgentEnv } from './env';
import { observeChildInput, provideChildFacts } from './child-input';

async function fixture(agentId: 'business_research' | 'deep_research' = 'business_research') {
  const f = taskTestDb();
  f.sqlite.exec("alter table sites add column workspace_id text default 'w'");
  const parent = await attachTask(f.db, f.run('parent', 'parent'), agentDefinition('strategy_research'));
  const parentExecution = await createRuntimeExecution(f.db, parent.active_run_id);
  await activateRuntimeExecution(f.db, authorityForExecution(parentExecution), parentExecution.workflow_id);
  const create = vi.fn(async (options: { id: string; params: unknown }) => ({ id: options.id }));
  const host = { DB: f.db, AGENT_RUNTIME_ENABLED: 'true', AGENT_WORKFLOW: { create, get: async () => { throw new Error('not found'); } } } as unknown as RuntimeAgentEnv;
  const env = executionEnvironment(host, authorityForExecution(parentExecution));
  const task = await requireTask(env.DB, parent.active_run_id);
  const operation = await beginTaskDecision(env.DB, task, {});
  await startRuntimeRun(env, { runId: 'child', instanceId: 'child', workspaceId: 'w', siteId: 's', agentId,
    trigger: 'sub_agent', parentRunId: parent.active_run_id, summary: { research_question: 'Determine supported markets', locale: 'en' } });
  const childExecution = (await currentExecution(f.db, 'child'))!;
  await activateRuntimeExecution(f.db, authorityForExecution(childExecution), childExecution.workflow_id);
  await stopTask(executionEnvironment(host, authorityForExecution(childExecution)).DB, 'child', 'waiting', 'Missing a supported-market fact', 'waiting');
  const child = (await taskForRun(f.db, 'child'))!;
  const ref = (await observeChildInput(env, task, child))!;
  const args = { input_ref: ref, facts: 'The product documentation lists market A as supported.', sources: ['Official product documentation, section Markets'] };
  create.mockClear();
  return { ...f, host, env, task, operation, parentExecution, childExecution, child, args, create };
}

it.each(['business_research', 'deep_research'] as const)('delivers facts to the original %s Task/Run and replays one input and execution', async agentId => {
  const f = await fixture(agentId);
  const receipt = await provideChildFacts(f.env, f.task, f.operation, f.args);
  expect(receipt).toMatchObject({ task_ref: 'child', run_ref: 'child', input_saved: true, receipt_kind: 'task_information_supplied' });
  const execution = (await currentExecution(f.db, 'child'))!;
  expect(execution.epoch).toBe(f.childExecution.epoch + 1);
  expect(f.create.mock.calls[0][0].params).toMatchObject({ execution: authorityForExecution(execution) });
  await provideChildFacts(f.env, f.task, f.operation, f.args);
  expect(await f.db.prepare('select count(*) n from agent_task_inputs').first('n')).toBe(1);
  expect(await f.db.prepare('select count(*) n from agent_runs').first('n')).toBe(2);
  expect(await f.db.prepare('select count(*) n from agent_runtime_executions where task_id=?').bind('child').first('n')).toBe(2);
  const row = await f.db.prepare('select actor_id,content from agent_task_inputs').first<{ actor_id: string; content: string }>();
  expect(row!.actor_id).toBe('parent');
  expect(JSON.parse(row!.content)).toMatchObject({ type: 'parent_facts', facts: f.args.facts, reported_sources: f.args.sources });
  expect(row!.content).not.toContain('hitl_response');
  await expect(provideChildFacts(f.env, f.task, f.operation, { ...f.args, facts: 'Changed replay' })).rejects.toThrow('binding changed');
  // The child consumes the input, then reaches a different wait. Parent replay
  // may not restart that wait or select a more recent execution.
  await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  await stopTask(executionEnvironment(f.host, authorityForExecution(execution)).DB, 'child', 'waiting', 'A new question');
  f.create.mockClear();
  await provideChildFacts(f.env, f.task, f.operation, f.args);
  expect(f.create).not.toHaveBeenCalled();
  expect((await taskForRun(f.db, 'child'))!.status).toBe('waiting');
});

it('recovers a lost commit response without appending twice or selecting a new wait', async () => {
  const f = await fixture();
  let interrupted = false;
  const db = new Proxy(f.env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
      const result = await target.batch(statements);
      if (!interrupted && await f.db.prepare('select 1 from agent_task_inputs').first()) { interrupted = true; throw new Error('Commit response lost'); }
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(provideChildFacts({ ...f.env, DB: db }, f.task, f.operation, f.args)).rejects.toThrow('Commit response lost');
  expect(f.create).not.toHaveBeenCalled();
  await provideChildFacts(f.env, f.task, f.operation, f.args);
  expect(await f.db.prepare('select count(*) n from agent_task_inputs').first('n')).toBe(1);
  expect(f.create).toHaveBeenCalledOnce();
});

it('reconciles an unknown Workflow create response with the same dispatch identity', async () => {
  const f = await fixture();
  f.create.mockRejectedValueOnce(new Error('Dispatch response lost'));
  await expect(provideChildFacts(f.env, f.task, f.operation, f.args)).rejects.toThrow('Dispatch response lost');
  await provideChildFacts(f.env, f.task, f.operation, f.args);
  expect(new Set(f.create.mock.calls.map(call => call[0].id)).size).toBe(1);
  expect(await f.db.prepare('select count(*) n from agent_task_inputs').first('n')).toBe(1);
});

it.each(['running', 'completed', 'cancelled'] as const)('rejects the old observation when the child becomes %s', async status => {
  const f = await fixture();
  f.sqlite.prepare('update agent_tasks set status=? where id=?').run(status, 'child');
  await expect(provideChildFacts(f.env, f.task, f.operation, f.args)).rejects.toThrow('changed');
  expect(await f.db.prepare('select count(*) n from agent_task_inputs').first('n')).toBe(0);
  expect(f.create).not.toHaveBeenCalled();
});

it('preserves a submitted human response and does not falsely report its successor as our commit', async () => {
  const f = await fixture();
  let raced = false;
  const db = new Proxy(f.env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
      if (!raced) { raced = true; await createRuntimeExecution(f.db, 'child', f.childExecution, 'human_response'); f.sqlite.prepare("update agent_runs set status='running',phase='model' where id='child'").run(); }
      return target.batch(statements);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(provideChildFacts({ ...f.env, DB: db }, f.task, f.operation, f.args)).rejects.toThrow('changed');
  expect(await f.db.prepare('select count(*) n from agent_task_inputs').first('n')).toBe(0);
  expect(f.create).not.toHaveBeenCalled();
  expect(await f.db.prepare("select status,phase from agent_runs where id='child'").first()).toEqual({status:'running',phase:'model'});
});

it('does not append facts while a human response claim is being processed', async () => {
  const f = await fixture();
  f.sqlite.prepare(`insert into agent_work_responses(command_id,task_id,request_id,version,actor_id,input_json,created_at)
    values('human','child','hitl:question','1','user','{}','now')`).run();
  await expect(provideChildFacts(f.env, f.task, f.operation, f.args)).rejects.toThrow('human response');
  expect(await f.db.prepare('select count(*) n from agent_task_inputs').first('n')).toBe(0);
});

it('rolls back facts and continuation when the parent execution changes before commit', async () => {
  const f = await fixture();
  const db = new Proxy(f.env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
      await createRuntimeExecution(f.db, 'parent', f.parentExecution, 'replacement');
      return target.batch(statements);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(provideChildFacts({ ...f.env, DB: db }, f.task, f.operation, f.args)).rejects.toThrow();
  expect(await f.db.prepare('select count(*) n from agent_task_inputs').first('n')).toBe(0);
  expect((await currentExecution(f.db, 'child'))!.id).toBe(f.childExecution.id);
});

it('refuses cross-task references and unknown child effects without bypassing reconciliation', async () => {
  const f = await fixture();
  await expect(provideChildFacts(f.env, f.task, f.operation, { ...f.args, input_ref: 'invented' })).rejects.toThrow('out-of-scope');
  f.sqlite.prepare(`insert into agent_task_operations(id,task_id,turn,status,context_json,created_at,updated_at)
    values('child:1','child',1,'unknown','{}','now','now')`).run();
  await expect(provideChildFacts(f.env, f.task, f.operation, f.args)).rejects.toThrow('unknown effect');
  expect(await f.db.prepare('select count(*) n from agent_task_inputs').first('n')).toBe(0);
});
