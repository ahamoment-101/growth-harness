import { expect, it, vi } from 'vitest';
import { agentDefinition } from '../agent-runtime/definitions';
import { strategyTaskTools } from '../agent-runtime/strategy-task';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { attachTask, beginTaskDecision, requireTask, stopTask, taskForRun } from '../agent-runtime/task-store';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { executionEnvironment } from '../agent-runtime/execution-context';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution, currentExecution } from '../agent-runtime/runtime-executions';
import { observeChildInput, provideChildFacts } from '../agent-runtime/child-input';
import { ToolRegistry } from '../agent-runtime/tools';
import type { WorkResponse } from '../../shared/agent-work';
import { respondToWork, workInteractions, pendingWork } from './index';
import { hitlWorkProvider } from './hitl-provider';
import { hitlTool } from './hitl-tool';
import { runtimeWorkProvider } from './runtime-provider';

const spec = {
  schema_version: 1 as const, title: 'Confirm target market', description: 'The existing business materials do not specify the target market for this round.',
  blocks: [
    { type: 'text' as const, text: 'Please select the market to prioritize researching this time.' },
    { type: 'choice' as const, id: 'market', label: 'Target market', required: true, options: [
      { value: 'us', label: 'United States' }, { value: 'uk', label: 'United Kingdom' },
    ] },
    { type: 'textarea' as const, id: 'context', label: 'Additional context', max_length: 500 },
  ],
  actions: [{ id: 'submit', label: 'Submit message', tone: 'primary' as const, required_fields: ['market'] }],
};

it('persists an Agent-composed request and resumes the same Task and Run from a structured response', async () => {
  const f = taskTestDb();
  const run = f.run();
  const task = await attachTask(f.db, run, agentDefinition('strategy_research'));
  const operation = await beginTaskDecision(f.db, task, {});
  const definition = agentDefinition('strategy_research');
  const registry = strategyTaskTools({ env: { DB: f.db } as RuntimeAgentEnv, definition, task, operation, runId: run.id, locale: 'en' });
  const args = { spec, resume_when: 'Continue research after receiving market information' };
  const context = { runId: run.id, workspaceId: task.workspace_id, siteId: task.site_id, idempotencyKey: operation.id };
  const output = await registry.execute(definition, 'request_human_input', args, context) as { request_id: string; title: string };
  expect(output).toEqual({ request_id: `hitl:${operation.id}`, title: spec.title, resume_when: args.resume_when });
  expect(await registry.execute(definition, 'request_human_input', args, context)).toEqual(output);
  await stopTask(f.db, run.id, 'waiting', 'Waiting for user response');
  const current = (await taskForRun(f.db, run.id))!;
  const requestContext = { db: f.db as unknown as D1Database, workspaceId: task.workspace_id, siteId: task.site_id, task: current };
  expect((await workInteractions(requestContext, [hitlWorkProvider, runtimeWorkProvider])).filter(node => node.interaction?.state === 'pending')).toMatchObject([
    { title: spec.title, interaction: { spec } },
  ]);
  expect(await pendingWork(requestContext, task.agent_id, [hitlWorkProvider, runtimeWorkProvider])).toHaveLength(1);
  const response: WorkResponse = { request_id: output.request_id, version: '1', action: 'submit', values: { market: 'us', context: 'Serving US clients' }, command_id: 'hitl-test-1' };
  const create = vi.fn().mockRejectedValueOnce(new Error('Lost dispatch')).mockResolvedValue({ id: 'accepted' });
  const env = { DB: f.db, AGENT_RUNTIME_ENABLED: 'true', AGENT_WORKFLOW: { create, get: async () => { throw new Error('unavailable'); } } } as unknown as RuntimeAgentEnv;
  await expect(respondToWork(env, requestContext, response, 'user-1', [hitlWorkProvider])).rejects.toThrow('Lost dispatch');
  expect((await workInteractions(requestContext, [hitlWorkProvider])).some(node => node.interaction?.pending_submission?.command_id === response.command_id)).toBe(true);
  const receipt = await respondToWork(env, requestContext, response, 'user-1', [hitlWorkProvider]);
  expect(receipt.message).toContain('original task');
  expect(await respondToWork(env, requestContext, response, 'user-1', [hitlWorkProvider])).toEqual(receipt);
  expect(f.sqlite.prepare('select count(*) as n from agent_runs').get()).toEqual({ n: 1 });
  expect(f.sqlite.prepare('select count(*) as n from agent_task_inputs').get()).toEqual({ n: 1 });
  const input = f.sqlite.prepare('select content from agent_task_inputs').get() as { content: string };
  expect(JSON.parse(input.content)).toEqual({ type: 'hitl_response', request_id: output.request_id, version: '1', action: 'submit', values: response.values });
  expect((await workInteractions(requestContext, [hitlWorkProvider])).some(node => node.interaction?.state === 'resolved')).toBe(true);
  expect(create).toHaveBeenCalledTimes(2);
});

it('rejects hidden input and keeps older strategy task tool manifests unchanged', async () => {
  const f = taskTestDb();
  const run = f.run();
  const task = await attachTask(f.db, run, agentDefinition('strategy_research'));
  const operation = await beginTaskDecision(f.db, task, {});
  const definition = agentDefinition('strategy_research');
  const registry = strategyTaskTools({ env: { DB: f.db } as RuntimeAgentEnv, definition, task, operation, runId: run.id, locale: 'en' });
  const context = { runId: run.id, workspaceId: task.workspace_id, siteId: task.site_id, idempotencyKey: operation.id };
  const output = await registry.execute(definition, 'request_human_input', { spec: {
    ...spec, blocks: [...spec.blocks, { type: 'textarea', id: 'reason', label: 'Reason', show_when: { field: 'market', equals: 'uk' } }],
  }, resume_when: 'Continue' }, context) as { request_id: string };
  await stopTask(f.db, run.id, 'waiting', 'Waiting for user response');
  const current = (await taskForRun(f.db, run.id))!;
  const requestContext = { db: f.db as unknown as D1Database, workspaceId: task.workspace_id, siteId: task.site_id, task: current };
  const input: WorkResponse = { request_id: output.request_id, version: '1', action: 'submit', values: { market: 'us', reason: 'Hidden' }, command_id: 'invalid-hitl' };
  await expect(respondToWork({ DB: f.db } as RuntimeAgentEnv, requestContext, input, 'user-1', [hitlWorkProvider])).rejects.toThrow('invisible');
  expect(f.sqlite.prepare('select count(*) as n from agent_task_inputs').get()).toEqual({ n: 0 });
  f.sqlite.prepare('update agent_tasks set definition_version=38 where id=?').run(task.id);
  const old = (await taskForRun(f.db, run.id))!;
  expect(strategyTaskTools({ env: { DB: f.db } as RuntimeAgentEnv, definition, task: old, operation, runId: run.id, locale: 'en' }).names()).not.toContain('request_human_input');
});

async function childRequestFixture() {
  const f = taskTestDb();
  const attachedParent = await attachTask(f.db, f.run('parent', 'parent'), agentDefinition('strategy_research'));
  const parentExecution = await createRuntimeExecution(f.db, attachedParent.active_run_id);
  await activateRuntimeExecution(f.db, authorityForExecution(parentExecution), parentExecution.workflow_id);
  const create = vi.fn(async (options: { id: string }) => ({ id: options.id }));
  const host = { DB: f.db, AGENT_RUNTIME_ENABLED: 'true', AGENT_WORKFLOW: { create, get: async () => { throw new Error('not found'); } } } as unknown as RuntimeAgentEnv;
  const parentEnv = executionEnvironment(host, authorityForExecution(parentExecution));
  const parent = await requireTask(parentEnv.DB, attachedParent.active_run_id);
  const parentOperation = await beginTaskDecision(parentEnv.DB, parent, {});
  const childRun = { ...f.run('child', 'child'), agent_id: 'business_research' as const, parent_run_id: parent.active_run_id };
  f.sqlite.prepare('update agent_runs set agent_id=?,parent_run_id=? where id=?').run(childRun.agent_id, childRun.parent_run_id, childRun.id);
  const child = await attachTask(parentEnv.DB, childRun, agentDefinition('business_research'));
  const childExecution = await createRuntimeExecution(parentEnv.DB, child.active_run_id);
  await activateRuntimeExecution(f.db, authorityForExecution(childExecution), childExecution.workflow_id);
  const childEnv = executionEnvironment(host, authorityForExecution(childExecution));
  const activeChild = await requireTask(childEnv.DB, child.active_run_id);
  const operation = await beginTaskDecision(childEnv.DB, activeChild, {});
  const registry = new ToolRegistry().register(hitlTool(childEnv, activeChild, operation));
  const request = await registry.execute(agentDefinition('business_research'), 'request_human_input', { spec, resume_when: 'Reassess the supported market' },
    { runId: child.active_run_id, workspaceId: 'w', siteId: 's', idempotencyKey: operation.id }) as { request_id: string };
  await stopTask(childEnv.DB, child.active_run_id, 'waiting', 'Waiting for market information');
  const waiting = (await taskForRun(f.db, child.active_run_id))!;
  const inputRef = (await observeChildInput(parentEnv, parent, waiting))!;
  const facts = { input_ref: inputRef, facts: 'The parent found a document that mentions the US market.', sources: ['Product document, market section'] };
  const response: WorkResponse = { request_id: request.request_id, version: '1', action: 'submit', values: { market: 'us', context: 'The current confirmed market is US.' }, command_id: 'actual-human-market-answer' };
  const requestContext = { db: f.db, workspaceId: 'w', siteId: 's', task: waiting };
  return { ...f, host, parentEnv, parent, parentOperation, child, requestContext, response, facts };
}

it.each(['queued', 'running'] as const)('does not consume a human answer while parent facts have made the child %s', async phase => {
  const f = await childRequestFixture();
  await provideChildFacts(f.parentEnv, f.parent, f.parentOperation, f.facts);
  const execution = (await currentExecution(f.db, f.child.active_run_id))!;
  if (phase === 'running') await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  expect((await currentExecution(f.db, f.child.active_run_id))!.status).toBe(phase === 'queued' ? 'dispatching' : 'running');
  expect((await taskForRun(f.db, f.child.active_run_id))!.status).toBe('running');
  // The browser may still hold the earlier waiting snapshot. The claim must
  // consult the live task and must not record a discarded/superseded answer.
  await expect(respondToWork(f.host, f.requestContext, f.response, 'actual-user', [hitlWorkProvider])).rejects.toThrow('already being processed');
  expect(f.sqlite.prepare('select count(*) n from agent_work_responses').get()).toEqual({ n: 0 });
  expect(f.sqlite.prepare('select state from agent_work_requests').get()).toEqual({ state: 'pending' });
  const inputs = f.sqlite.prepare('select content from agent_task_inputs').all() as Array<{ content: string }>;
  expect(inputs).toHaveLength(1);
  expect(JSON.parse(inputs[0].content).type).toBe('parent_facts');
  // If the child decides the facts are insufficient, the same human submission
  // remains usable once the original question is again waiting for its answer.
  if (phase === 'queued') await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  await stopTask(executionEnvironment(f.host, authorityForExecution(execution)).DB, f.child.active_run_id, 'waiting', 'The original market question still needs a response');
  const receipt = await respondToWork(f.host, { ...f.requestContext, task: (await taskForRun(f.db, f.child.active_run_id))! }, f.response, 'actual-user', [hitlWorkProvider]);
  expect(receipt.message).toContain('original task');
  expect(f.sqlite.prepare('select count(*) n from agent_work_responses').get()).toEqual({ n: 1 });
  expect(f.sqlite.prepare('select state from agent_work_requests').get()).toEqual({ state: 'resolved' });
  const accepted = f.sqlite.prepare('select content from agent_task_inputs where id=?').get(f.response.command_id) as { content: string };
  expect(JSON.parse(accepted.content)).toEqual({ type: 'hitl_response', request_id: f.response.request_id, version: '1', action: 'submit', values: f.response.values });
});

it('preserves the submitted human answer when it wins before the parent facts', async () => {
  const f = await childRequestFixture();
  const receipt = await respondToWork(f.host, f.requestContext, f.response, 'actual-user', [hitlWorkProvider]);
  expect(receipt.message).toContain('original task');
  await expect(provideChildFacts(f.parentEnv, f.parent, f.parentOperation, f.facts)).rejects.toThrow('changed after observation');
  expect(await respondToWork(f.host, f.requestContext, f.response, 'actual-user', [hitlWorkProvider])).toEqual(receipt);
  expect(f.sqlite.prepare('select count(*) n from agent_work_responses').get()).toEqual({ n: 1 });
  const inputs = f.sqlite.prepare('select id,content from agent_task_inputs').all() as Array<{ id: string; content: string }>;
  expect(inputs).toHaveLength(1);
  expect(inputs[0].id).toBe(f.response.command_id);
  expect(JSON.parse(inputs[0].content)).toMatchObject({ type: 'hitl_response', values: f.response.values });
  expect(f.sqlite.prepare('select state from agent_work_requests').get()).toEqual({ state: 'resolved' });
});

it('rechecks waiting atomically when parent facts arrive after response validation but before its claim', async () => {
  const f = await childRequestFixture();
  let raced = false;
  const db = new Proxy(f.db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.includes('insert or ignore into agent_work_responses')) return statement;
      const wrap = (current: typeof statement): typeof statement => new Proxy(current, { get(value, field) {
        if (field === 'bind') return (...parameters: unknown[]) => wrap(value.bind(...parameters));
        if (field === 'run') return async () => {
          if (!raced) { raced = true; await provideChildFacts(f.parentEnv, f.parent, f.parentOperation, f.facts); }
          return value.run();
        };
        const member = Reflect.get(value, field);
        return typeof member === 'function' ? member.bind(value) : member;
      } });
      return wrap(statement);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(respondToWork(f.host, { ...f.requestContext, db }, f.response, 'actual-user', [hitlWorkProvider])).rejects.toThrow('already being processed');
  expect(raced).toBe(true);
  expect(f.sqlite.prepare('select count(*) n from agent_work_responses').get()).toEqual({ n: 0 });
  expect(f.sqlite.prepare('select state from agent_work_requests').get()).toEqual({ state: 'pending' });
  const inputs = f.sqlite.prepare('select content from agent_task_inputs').all() as Array<{ content: string }>;
  expect(inputs).toHaveLength(1);
  expect(JSON.parse(inputs[0].content).type).toBe('parent_facts');
});
