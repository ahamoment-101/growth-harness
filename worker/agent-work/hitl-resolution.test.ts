import { describe, expect, it } from 'vitest';
import { agentDefinition, type AgentDefinition } from '../agent-runtime/definitions';
import { executionEnvironment } from '../agent-runtime/execution-context';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution } from '../agent-runtime/runtime-executions';
import { attachTask, beginTaskDecision, finishTaskTerminal, requireTask } from '../agent-runtime/task-store';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { ToolRegistry } from '../agent-runtime/tools';
import { hitlWorkNode } from './hitl-node';
import { HITL_RESOLUTION_TOOL_NAMES, registerHitlResolutionTools } from './hitl-resolution';
import { createWorkRequest } from './requests';

type Page = { requests: Array<{ request_ref: string; request_id: string; version: string; title: string; response_pending: boolean }>; next_cursor_ref: string | null };
const spec = { schema_version: 1 as const, title: 'Confirm the supported market', blocks: [{ type: 'text' as const, text: 'Which market is currently supported?' }], actions: [{ id: 'confirm', label: 'Confirm' }] };

async function fixture(id = 'owner') {
  const f = taskTestDb();
  const attached = await attachTask(f.db, f.run(id, id), agentDefinition('strategy_research'));
  const execution = await createRuntimeExecution(f.db, attached.active_run_id);
  await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  const env = executionEnvironment({ DB: f.db } as RuntimeAgentEnv, authorityForExecution(execution));
  const task = await requireTask(env.DB, attached.active_run_id);
  const operation = await beginTaskDecision(env.DB, task, {});
  const definition = { ...agentDefinition('strategy_research'), tools: [...HITL_RESOLUTION_TOOL_NAMES] } as AgentDefinition;
  const registry = registerHitlResolutionTools(new ToolRegistry(), env, task, operation);
  const context = { runId: task.active_run_id, workspaceId: task.workspace_id, siteId: task.site_id, idempotencyKey: operation.id };
  const add = (requestId: string, at = '2026-10-24T00:00:00.000Z') => createWorkRequest({ db: env.DB, task, workspaceId: task.workspace_id, siteId: task.site_id }, 'hitl', hitlWorkNode(requestId, at, spec));
  const read = async (input = {}) => await registry.execute(definition, 'read_human_input_requests', input, context) as Page;
  const resolve = (input: { request_ref: string; decision: 'withdraw' | 'keep_waiting'; reason: string }) => registry.execute(definition, 'resolve_human_input_request', input, context);
  return { ...f, execution, env, task, operation, definition, registry, context, add, read, resolve };
}

describe('own human-input request decisions', () => {
  it('pages only the current task requests and returns host-owned observations', async () => {
    const f = await fixture();
    await f.add('hitl:first');
    await f.add('hitl:second');
    await f.add('hitl:third');
    const other = await attachTask(f.db, f.run('other', 'other'), agentDefinition('strategy_research'));
    await createWorkRequest({ db: f.db, task: other, workspaceId: 'w', siteId: 's' }, 'hitl', hitlWorkNode('hitl:other', 'now', spec));
    const first = await f.read({ limit: 2 });
    expect(first.requests.map(request => request.request_id)).toEqual(['hitl:first', 'hitl:second']);
    expect(first.requests.every(request => request.request_ref.startsWith('ref-'))).toBe(true);
    const second = await f.read({ limit: 2, cursor_ref: first.next_cursor_ref });
    expect(second.requests.map(request => request.request_id)).toEqual(['hitl:third']);
    expect(second.next_cursor_ref).toBeNull();
    await expect(f.read({ limit: 21 })).rejects.toThrow();
    await expect(f.read({ cursor_ref: first.requests[0].request_ref })).rejects.toThrow('wrong-type');
  });

  it('withdraws only the observed question and durably replays without creating a human answer', async () => {
    const f = await fixture();
    await f.add('hitl:question');
    const snapshot = f.sqlite.prepare('select node_json from agent_work_requests').get();
    const [request] = (await f.read()).requests;
    const input = { request_ref: request.request_ref, decision: 'withdraw' as const, reason: 'The official source now supplies the missing factual information.' };
    const first = await f.resolve(input);
    expect(first).toMatchObject({ request_id: 'hitl:question', decision: 'withdraw', reason: input.reason, meaning: expect.stringContaining('no human answer') });
    expect(await f.resolve(input)).toEqual(first);
    expect(f.sqlite.prepare('select state from agent_work_requests').get()).toEqual({ state: 'resolved' });
    expect(f.sqlite.prepare('select node_json from agent_work_requests').get()).toEqual(snapshot);
    expect(f.sqlite.prepare('select count(*) n from agent_work_responses').get()).toEqual({ n: 0 });
    expect(f.sqlite.prepare('select count(*) n from agent_task_inputs').get()).toEqual({ n: 0 });
    expect(f.sqlite.prepare('select count(*) n from agent_runtime_executions').get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare('select status from agent_tasks where id=?').get(f.task.id)).toEqual({ status: 'running' });
    const saved = f.sqlite.prepare('select status,output_json from agent_task_operations where id=?').get(f.operation.id) as { status: string; output_json: string };
    expect(saved.status).toBe('succeeded');
    expect(JSON.parse(saved.output_json)).toEqual(first);
    await expect(f.resolve({ ...input, reason: 'A different decision' })).rejects.toThrow('binding changed');
    expect((await f.read()).requests).toHaveLength(0);
  });

  it('keeps the original question pending and completes into the same Task and Run wait', async () => {
    const f = await fixture();
    await f.add('hitl:question');
    const [request] = (await f.read()).requests;
    const input = { request_ref: request.request_ref, decision: 'keep_waiting' as const, reason: 'The supplied facts do not resolve the requested market decision.' };
    const result = await f.resolve(input);
    expect(await f.resolve(input)).toEqual(result);
    expect(f.sqlite.prepare('select status from agent_task_operations where id=?').get(f.operation.id)).toEqual({ status: 'deciding' });
    const completion = f.registry.resolve(f.definition, 'resolve_human_input_request').completion!(result)!;
    expect(completion).toMatchObject({ status: 'waiting', outcome: 'waiting', output: { request_id: 'hitl:question', resume_when: input.reason } });
    await finishTaskTerminal(f.env.DB, f.task, f.operation, completion);
    expect(f.sqlite.prepare('select state from agent_work_requests').get()).toEqual({ state: 'pending' });
    expect(f.sqlite.prepare('select id,active_run_id,status from agent_tasks').get()).toEqual({ id: f.task.id, active_run_id: f.task.active_run_id, status: 'waiting' });
    expect(f.sqlite.prepare('select count(*) n from agent_work_requests').get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare('select count(*) n from agent_runs').get()).toEqual({ n: 1 });
  });

  it.each(['version', 'state'] as const)('rejects a changed request %s without recording success', async field => {
    const f = await fixture();
    await f.add('hitl:question');
    const [request] = (await f.read()).requests;
    f.sqlite.prepare(field === 'version' ? "update agent_work_requests set version='2'" : "update agent_work_requests set state='resolved'").run();
    await expect(f.resolve({ request_ref: request.request_ref, decision: 'withdraw', reason: 'Evidence found' })).rejects.toThrow('request changed');
    expect(f.sqlite.prepare('select status from agent_task_operations where id=?').get(f.operation.id)).toEqual({ status: 'deciding' });
  });

  it.each(['withdraw', 'keep_waiting'] as const)('preserves an in-flight human response before %s', async decision => {
    const f = await fixture();
    await f.add('hitl:question');
    const [request] = (await f.read()).requests;
    f.sqlite.prepare(`insert into agent_work_responses(command_id,task_id,request_id,version,actor_id,input_json,created_at)
      values('human-command',?,'hitl:question','1','actual-user','{"action":"confirm"}','now')`).run(f.task.id);
    expect((await f.read()).requests[0].response_pending).toBe(true);
    await expect(f.resolve({ request_ref: request.request_ref, decision, reason: 'New facts' })).rejects.toThrow('response is already being processed');
    expect(f.sqlite.prepare('select state from agent_work_requests').get()).toEqual({ state: 'pending' });
    expect(f.sqlite.prepare('select input_json,receipt_json from agent_work_responses').get()).toEqual({ input_json: '{"action":"confirm"}', receipt_json: '' });
  });

  it('rejects foreign observed references and parent credentials used as the child executor', async () => {
    const f = await fixture();
    await f.add('hitl:question');
    const childRun = { ...f.run('child', 'child'), parent_run_id: f.task.active_run_id };
    f.sqlite.prepare('update agent_runs set parent_run_id=? where id=?').run(f.task.active_run_id, childRun.id);
    const child = await attachTask(f.env.DB, childRun, agentDefinition('strategy_research'));
    const childExecution = await createRuntimeExecution(f.env.DB, child.active_run_id);
    await activateRuntimeExecution(f.db, authorityForExecution(childExecution), childExecution.workflow_id);
    const childEnv = executionEnvironment({ DB: f.db } as RuntimeAgentEnv, authorityForExecution(childExecution));
    const currentChild = await requireTask(childEnv.DB, child.active_run_id);
    const childOperation = await beginTaskDecision(childEnv.DB, currentChild, {});
    const foreign = (await f.read()).requests[0].request_ref;
    const childRegistry = registerHitlResolutionTools(new ToolRegistry(), childEnv, currentChild, childOperation);
    await expect(childRegistry.execute(f.definition, 'resolve_human_input_request', { request_ref: foreign, decision: 'withdraw', reason: 'Invalid cross-task request' }, { ...f.context, runId: child.active_run_id })).rejects.toThrow('out-of-scope');
    const impersonation = registerHitlResolutionTools(new ToolRegistry(), f.env, currentChild, childOperation);
    await expect(impersonation.execute(f.definition, 'read_human_input_requests', {}, f.context)).rejects.toThrow('stale');
    expect(f.sqlite.prepare('select state from agent_work_requests').get()).toEqual({ state: 'pending' });
  });

  it('fences both request mutation and receipt when authority changes after binding', async () => {
    const f = await fixture();
    await f.add('hitl:question');
    const [request] = (await f.read()).requests;
    const raced = new Proxy(f.env.DB, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
        await createRuntimeExecution(f.db, f.task.active_run_id, f.execution, 'replacement');
        return target.batch(statements);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const registry = registerHitlResolutionTools(new ToolRegistry(), { ...f.env, DB: raced }, f.task, f.operation);
    await expect(registry.execute(f.definition, 'resolve_human_input_request', { request_ref: request.request_ref, decision: 'withdraw', reason: 'New evidence' }, f.context)).rejects.toThrow();
    expect(f.sqlite.prepare('select state from agent_work_requests').get()).toEqual({ state: 'pending' });
    expect(f.sqlite.prepare('select status from agent_task_operations where id=?').get(f.operation.id)).toEqual({ status: 'deciding' });
  });

  it('reconciles a lost withdrawal response from its atomic saved receipt', async () => {
    const f = await fixture();
    await f.add('hitl:question');
    const [request] = (await f.read()).requests;
    let interrupted = false;
    const interruptedDb = new Proxy(f.env.DB, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
        const result = await target.batch(statements);
        if (!interrupted) { interrupted = true; throw new Error('Lost withdrawal response'); }
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const registry = registerHitlResolutionTools(new ToolRegistry(), { ...f.env, DB: interruptedDb }, f.task, f.operation);
    const input = { request_ref: request.request_ref, decision: 'withdraw', reason: 'Confirmed from an attributed source' };
    await expect(registry.execute(f.definition, 'resolve_human_input_request', input, f.context)).rejects.toThrow('Lost withdrawal response');
    expect(await registry.execute(f.definition, 'resolve_human_input_request', input, f.context)).toMatchObject({ request_id: 'hitl:question', decision: 'withdraw', reason: input.reason });
    expect(f.sqlite.prepare('select count(*) n from agent_work_responses').get()).toEqual({ n: 0 });
    expect(f.sqlite.prepare('select state from agent_work_requests').get()).toEqual({ state: 'resolved' });
  });

  it('rechecks a response claim inside the withdrawal transaction', async () => {
    const f = await fixture();
    await f.add('hitl:question');
    const [request] = (await f.read()).requests;
    const raced = new Proxy(f.env.DB, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
        f.sqlite.prepare(`insert into agent_work_responses(command_id,task_id,request_id,version,actor_id,input_json,created_at)
          values('racing-human',?,'hitl:question','1','actual-user','{}','now')`).run(f.task.id);
        return target.batch(statements);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const registry = registerHitlResolutionTools(new ToolRegistry(), { ...f.env, DB: raced }, f.task, f.operation);
    await expect(registry.execute(f.definition, 'resolve_human_input_request', { request_ref: request.request_ref, decision: 'withdraw', reason: 'New evidence' }, f.context)).rejects.toThrow('response is already being processed');
    expect(f.sqlite.prepare('select state from agent_work_requests').get()).toEqual({ state: 'pending' });
    expect(f.sqlite.prepare('select status from agent_task_operations where id=?').get(f.operation.id)).toEqual({ status: 'deciding' });
  });
});
