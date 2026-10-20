import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('agents', () => ({ getAgentByName: vi.fn() }));
import * as conversations from './conversation-store';
import { taskTestDb } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, commitTaskModel, finishTaskOperation, prepareTaskModel, stopTask, taskForRun } from './task-store';
import { executionEnvironment } from './execution-context';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution, currentExecution, dispatchExecution } from './runtime-executions';
import { recordExecutionFailure } from './task-recovery';
import { startRuntimeRun } from './run-service';
import { executeTaskCommand } from './task-commands';
import { traceRuntimeModelAttempt } from './observability';
import type { RuntimeAgentEnv } from './env';
import type { AssistantMessage } from '@earendil-works/pi-ai';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const decision: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture',
  stopReason: 'toolUse', timestamp: 1, content: [{ type: 'toolCall', id: 'pending', name: 'start_research_task', arguments: {} }],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

async function fixture(child = false) {
  const f = taskTestDb();
  f.sqlite.exec("alter table sites add column workspace_id text default 'w'; create table seo_strategy_runs(id text primary key,status text,phase text,error text,finished_at text)");
  const run = f.run('parent');
  const definition = agentDefinition('strategy_research');
  await attachTask(f.db, run, definition);
  const execution = await createRuntimeExecution(f.db, run.id);
  await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  const states = new Map<string, string>();
  const terminate = vi.fn(async (id: string) => { states.set(id, 'terminated'); });
  // Only the external Workflow control plane is a fixture. No model or HTTP calls.
  const host = { DB: f.db, AGENT_RUNTIME_ENABLED: 'true', AGENT_WORKFLOW: {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async (id: string) => ({ status: async () => ({ status: states.get(id) || 'running' }), terminate: () => terminate(id) })),
  } } as unknown as RuntimeAgentEnv;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in cancellation tests'); }));
  const env = executionEnvironment(host, authorityForExecution(execution));
  const task = (await taskForRun(f.db, run.id))!;
  await conversations.initializeConversation(env.DB, task, 'Cancellation role', {});
  let childExecution;
  if (child) {
    const started = await startRuntimeRun(env, { runId: 'child', workspaceId: 'w', siteId: 's', agentId: 'deep_research', instanceId: 'child',
      trigger: 'sub_agent', parentRunId: run.id, summary: { research_question: 'Synthetic cancellation evidence', locale: 'en' } });
    const first = (await currentExecution(f.db, started.id))!;
    await activateRuntimeExecution(f.db, authorityForExecution(first), first.workflow_id);
    childExecution = await createRuntimeExecution(f.db, started.id, first, 'distinct_child_epoch');
    await dispatchExecution(host, childExecution);
    await activateRuntimeExecution(f.db, authorityForExecution(childExecution), childExecution.workflow_id);
    await recovering(host, started.id);
  }
  const input = { run, command: 'cancel', commandId: 'cancel', actorId: 'owner', reason: 'User cancellation' };
  return { ...f, host, env, run, task, execution, childExecution, terminate, states, input };
}
async function recovering(env: RuntimeAgentEnv, runId: string) {
  await recordExecutionFailure(env, runId, { origin: 'upstream', scope: 'request', recovery_action: 'retry_request', message: 'Synthetic transport failure', status: 0, request_id: '', stage: 'conversation' });
}
async function pending(f: Awaited<ReturnType<typeof fixture>>, status: 'running' | 'unknown' | 'succeeded') {
  await conversations.appendConversationMessage(f.env.DB, f.task, 'decision', decision);
  const operation = await conversations.bindConversationOperation(f.env.DB, f.task, 'pending', {});
  await f.db.prepare('update agent_task_operations set status=?,external_json=? where id=?').bind(status === 'succeeded' ? 'running' : status, '{"replay_safety":"unknown"}', operation.id).run();
  await f.db.prepare('update agent_tasks set last_operation_id=? where id=?').bind(operation.id, f.task.id).run();
  if (status === 'succeeded') await finishTaskOperation(f.env.DB, f.task, operation, { saved: 'durable-success' });
  return operation;
}

async function inflightModel(f: Awaited<ReturnType<typeof fixture>>) {
  await prepareTaskModel(f.env.DB, { runId: f.run.id, reservationId: 'physical-inflight', operationId: 'inflight-decision', tokens: 100,
    request: { messages: ['Synthetic request, never sent'] }, reusePredecessor: true });
  let entered!: () => void;
  let finish!: (value: unknown) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const deferred = new Promise(resolve => { finish = resolve; });
  const attempt = traceRuntimeModelAttempt(f.env.DB, { runId: f.run.id, purpose: 'conversation', physicalId: 'physical-inflight',
    decisionTurn: 2, attempt: 1, provider: 'fixture', model: 'fixture', verifiedRun: true }, async () => { entered(); return deferred; });
  const late = attempt.then(() => ({ ok: true, error: '' }), error => ({ ok: false, error: String(error) }));
  await started;
  // Existing partial payload/accounting observations must survive unknown outcome.
  await f.db.prepare("update agent_task_model_reservations set response_json=? where id='physical-inflight'").bind('{"partial":"saved"}').run();
  await f.db.prepare("update agent_model_attempts set input_tokens=21,output_tokens=5,cost_usd=0.02 where purpose='conversation::physical-inflight'").run();
  const snapshot = async () => ({
    reservation: await f.db.prepare("select * from agent_task_model_reservations where id='physical-inflight'").first<Record<string,unknown>>(),
    attempt: await f.db.prepare("select * from agent_model_attempts where purpose='conversation::physical-inflight'").first<Record<string,unknown>>(),
    accounting: await f.db.prepare('select reserved_tokens,model_calls,cost_usd from agent_tasks join agent_runs on agent_runs.id=agent_tasks.active_run_id where agent_tasks.id=?').bind(f.task.id).first(),
  });
  return { before: await snapshot(), snapshot, finish: async () => { finish({ text: 'Synthetic late output' }); return late; } };
}

describe('controller cancellation cleanup', () => {
  it.each(['running','complete','errored','terminated'])('settles in-flight model receipts only after confirming a closed host (%s)', async status => {
    const f = await fixture();
    const model = await inflightModel(f);
    f.states.set(f.execution.workflow_id, status);
    const receipt = await executeTaskCommand(f.host, f.input);
    const after = await model.snapshot();
    expect(receipt.task?.status).toBe('cancelled');
    expect(after.reservation).toEqual({ ...model.before.reservation, status: 'failed', outcome_state: 'unknown' });
    expect(after.attempt).toMatchObject({ ...model.before.attempt, status: 'failed', error_kind: 'outcome_unknown',
      error: 'Execution host closed before the model response receipt was saved', finished_at: expect.any(String) });
    expect(after.attempt?.finished_at).not.toBe('');
    expect(after.accounting).toEqual(model.before.accounting);
    expect(await f.db.prepare('select count(*) as n from agent_conversation_calls').first('n')).toBe(0);
    expect(f.terminate).toHaveBeenCalledTimes(status === 'running' ? 1 : 0);
    expect(await executeTaskCommand(f.host, f.input)).toEqual(receipt);
    expect(f.terminate).toHaveBeenCalledTimes(status === 'running' ? 1 : 0);
    expect(await model.finish()).toMatchObject({ ok: false, error: expect.stringContaining('authority lost') });
    await expect(commitTaskModel(f.env.DB, f.run.id, 'physical-inflight', { late: true }, 28)).rejects.toThrow();
    expect(await model.snapshot()).toEqual(after);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains running model receipts until termination succeeds and closure is confirmed on replay', async () => {
    const f = await fixture();
    const model = await inflightModel(f);
    f.terminate.mockRejectedValueOnce(new Error('Host termination failed'));
    await expect(executeTaskCommand(f.host, f.input)).rejects.toThrow('Host termination failed');
    expect(await model.snapshot()).toEqual(model.before);
    // A successful terminate response alone does not prove closure.
    f.terminate.mockImplementationOnce(async () => {});
    await expect(executeTaskCommand(f.host, f.input)).rejects.toThrow('closure is not confirmed');
    expect(await model.snapshot()).toEqual(model.before);
    await executeTaskCommand(f.host, f.input);
    expect((await model.snapshot()).reservation).toMatchObject({ status: 'failed', outcome_state: 'unknown' });
    await model.finish();
    expect(f.terminate).toHaveBeenCalledTimes(3);
  });

  it('preserves completed physical model receipts and accounting while settling another unknown request', async () => {
    const f = await fixture();
    await prepareTaskModel(f.env.DB, { runId: f.run.id, reservationId: 'completed-physical', operationId: 'completed-decision', tokens: 100,
      request: { messages: ['Known synthetic request'] }, reusePredecessor: true });
    const output = { text: 'Saved synthetic response' };
    await traceRuntimeModelAttempt(f.env.DB, { runId: f.run.id, purpose: 'conversation', physicalId: 'completed-physical', decisionTurn: 1,
      attempt: 1, provider: 'fixture', model: 'fixture', verifiedRun: true,
      usage: () => ({ inputTokens: 20, outputTokens: 10, costUsd: 0.01 }) }, async () => output);
    await commitTaskModel(f.env.DB, f.run.id, 'completed-physical', output, 30);
    const reservation = await f.db.prepare("select * from agent_task_model_reservations where id='completed-physical'").first();
    const attempt = await f.db.prepare("select * from agent_model_attempts where purpose='conversation::completed-physical'").first();
    const model = await inflightModel(f);
    await executeTaskCommand(f.host, f.input);
    expect(await f.db.prepare("select * from agent_task_model_reservations where id='completed-physical'").first()).toEqual(reservation);
    expect(await f.db.prepare("select * from agent_model_attempts where purpose='conversation::completed-physical'").first()).toEqual(attempt);
    expect((await model.snapshot()).accounting).toEqual(model.before.accounting);
    await model.finish();
  });

  it('replays model receipt cleanup without terminating a host whose successful cleanup is already saved', async () => {
    const f = await fixture();
    const model = await inflightModel(f);
    // External acknowledgement arrives but local request settlement fails once.
    const batch = f.db.batch.bind(f.db);
    let fail = true;
    f.host.DB = new Proxy(f.db, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
        if (fail && f.states.get(f.execution.workflow_id) === 'terminated') { fail = false; throw new Error('Model receipt storage unavailable'); }
        return batch(statements);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(executeTaskCommand(f.host, f.input)).rejects.toThrow('Model receipt storage unavailable');
    expect((await model.snapshot()).reservation?.status).toBe('running');
    expect(f.terminate).toHaveBeenCalledOnce();
    await executeTaskCommand(f.host, f.input);
    expect((await model.snapshot()).reservation?.status).toBe('failed');
    expect(f.terminate).toHaveBeenCalledOnce();
    await model.finish();
  });
  it.each([
    { recovering: false, status: 'running' }, { recovering: true, status: 'running' },
    { recovering: false, status: 'unknown' }, { recovering: true, status: 'unknown' },
    { recovering: false, status: 'succeeded' },
  ] as const)('closes saved calls and preserves effect evidence (%j)', async scenario => {
    const f = await fixture();
    const operation = await pending(f, scenario.status);
    if (scenario.recovering) await recovering(f.host, f.run.id);
    const receipt = await executeTaskCommand(f.host, f.input);
    expect(receipt.task?.status).toBe('cancelled');
    expect(receipt.run.status).toBe('cancelled');
    expect((await currentExecution(f.db, f.run.id))?.status).toBe('cancelled');
    expect(await f.db.prepare('select status from agent_task_operations where id=?').bind(operation.id).first('status')).toBe(scenario.status === 'running' ? 'unknown' : scenario.status);
    const snapshot = (await conversations.readConversation(f.db, f.task, { archive: true }))!;
    const result = snapshot.messages.at(-1)!.message;
    if (result.role !== 'toolResult') throw new Error('Expected persisted tool result');
    const output = JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}');
    if (scenario.status === 'succeeded') expect(output).toEqual({ saved: 'durable-success' });
    else { expect(output).toMatchObject({ effects: 'unknown', reconciliation_required: true }); expect(output).not.toHaveProperty('executed'); }
    expect(snapshot.calls[0].result_sequence).not.toBeNull();
    expect(await executeTaskCommand(f.host, f.input)).toEqual(receipt);
    expect(f.terminate).toHaveBeenCalledOnce();
    // A stale SDK executor cannot use the controller's terminal-result path.
    await expect(conversations.appendConversationMessage(f.env.DB, f.task, 'late', { role: 'user', content: 'late', timestamp: 2 })).rejects.toThrow();
    await expect(f.env.DB.prepare("update agent_task_operations set status='succeeded' where id=?").bind(operation.id).run()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels a waiting parent and real distinct-Agent recovering child with independent epochs', async () => {
    const f = await fixture(true);
    await pending(f, 'running');
    await stopTask(f.db, f.run.id, 'waiting', 'Awaiting child result');
    expect(f.execution.epoch).toBe(1); expect(f.childExecution?.epoch).toBe(2);
    await executeTaskCommand(f.host, f.input);
    expect(f.sqlite.prepare('select status from agent_tasks').all().every(r => r.status === 'cancelled')).toBe(true);
    expect(f.sqlite.prepare('select status from agent_runs').all().every(r => r.status === 'cancelled')).toBe(true);
    expect(f.terminate.mock.calls.map(args => args[0]).sort()).toEqual(['wf_child_2', 'wf_parent_1']);
    expect((await currentExecution(f.db, 'child'))?.status).toBe('cancelled');
    await executeTaskCommand(f.host, f.input);
    expect(f.terminate).toHaveBeenCalledTimes(2);
  });

  it('continues all other cleanup after a conversation failure, then replays only the missing step', async () => {
    const f = await fixture(true);
    await pending(f, 'unknown');
    const close = vi.spyOn(conversations, 'closeCancelledConversationCalls');
    const implementation = close.getMockImplementation()!;
    close.mockImplementationOnce(async () => { throw new Error('Injected conversation store outage'); }).mockImplementation(implementation);
    await expect(executeTaskCommand(f.host, f.input)).rejects.toThrow('cleanup remains pending');
    expect(f.sqlite.prepare('select status from agent_tasks').all().every(r => r.status === 'cancelled')).toBe(true);
    expect(f.sqlite.prepare('select status from agent_runs').all().every(r => r.status === 'cancelled')).toBe(true);
    expect(f.terminate).toHaveBeenCalledTimes(2);
    expect(await f.db.prepare('select receipt_json from agent_runtime_commands where command_id=?').bind('cancel').first('receipt_json')).toBe('{}');
    await executeTaskCommand(f.host, f.input);
    expect(f.terminate).toHaveBeenCalledTimes(2);
    expect(await f.db.prepare('select count(*) as n from agent_conversation_calls where result_sequence is null').first('n')).toBe(0);
  });

  it('retries failed host cleanup without repeating another host that already succeeded', async () => {
    const f = await fixture(true);
    f.terminate.mockImplementationOnce(async () => { throw new Error('Injected host outage'); });
    await expect(executeTaskCommand(f.host, f.input)).rejects.toThrow('Injected host outage');
    expect(f.terminate).toHaveBeenCalledTimes(2);
    await executeTaskCommand(f.host, f.input);
    expect(f.terminate).toHaveBeenCalledTimes(3);
    expect(f.terminate.mock.calls.filter(args => args[0] === 'wf_parent_1')).toHaveLength(1);
  });

  it('serializes concurrent same-ID controllers before external cleanup', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.terminate.mockImplementationOnce(async id => { entered(); await new Promise<void>(resolve => { release = resolve; }); f.states.set(id, 'terminated'); });
    const first = executeTaskCommand(f.host, f.input);
    await started;
    await expect(executeTaskCommand(f.host, f.input)).rejects.toThrow('already being processed');
    release();
    await first;
    await executeTaskCommand(f.host, f.input);
    expect(f.terminate).toHaveBeenCalledOnce();
  });

  it('reconciles a terminated host when the cleanup acknowledgement was lost', async () => {
    const f = await fixture();
    f.terminate.mockImplementationOnce(async id => { f.states.set(id, 'terminated'); throw new Error('Termination response lost'); });
    await expect(executeTaskCommand(f.host, f.input)).rejects.toThrow('Termination response lost');
    await executeTaskCommand(f.host, f.input);
    expect(f.terminate).toHaveBeenCalledOnce();
  });

  it('refuses stale captured controller epochs and execution-scoped controller calls', async () => {
    const f = await fixture();
    await expect(executeTaskCommand(f.env, f.input)).rejects.toThrow('controller authority');
    f.terminate.mockRejectedValueOnce(new Error('Interrupted cleanup'));
    await expect(executeTaskCommand(f.host, f.input)).rejects.toThrow('Interrupted cleanup');
    f.sqlite.prepare('update agent_tasks set epoch=epoch+1 where id=?').run(f.task.id);
    await expect(executeTaskCommand(f.host, f.input)).rejects.toThrow('scope is stale');
    expect(f.terminate).toHaveBeenCalledOnce();
  });

  it.each([{ executed: false, effects: 'none', error: 'Rejected before send' },
    { executed: true, effects: 'committed', saved_id: 'saved-effect', error: 'Receipt processing failed' }])
    ('preserves a failed operation with its actual known effect receipt (%j)', async output => {
      const f = await fixture();
      const operation = await pending(f, 'running');
      await f.db.prepare("update agent_task_operations set status='failed',output_json=? where id=?").bind(JSON.stringify(output),operation.id).run();
      await executeTaskCommand(f.host, f.input);
      const result = (await conversations.readConversation(f.db, f.task, { archive: true }))!.messages.at(-1)!.message;
      if (result.role !== 'toolResult') throw new Error('Expected persisted tool result');
      expect(result.isError).toBe(true);
      expect(result.content[0].type === 'text' && JSON.parse(result.content[0].text)).toEqual(output);
      expect(await f.db.prepare('select output_json from agent_task_operations where id=?').bind(operation.id).first('output_json')).toBe(JSON.stringify(output));
    });

  it('closes a running receipt as unknown without overwriting its already known effects or payload', async () => {
    const f = await fixture();
    const operation = await pending(f, 'running');
    const output = { effects: 'committed', saved_id: 'partial-effect', remaining: 'unknown' };
    await f.db.prepare('update agent_task_operations set output_json=? where id=?').bind(JSON.stringify(output),operation.id).run();
    const before = await f.db.prepare('select action_json,context_json,external_json,output_json from agent_task_operations where id=?').bind(operation.id).first();
    await executeTaskCommand(f.host, f.input);
    expect(await f.db.prepare('select status from agent_task_operations where id=?').bind(operation.id).first('status')).toBe('unknown');
    expect(await f.db.prepare('select action_json,context_json,external_json,output_json from agent_task_operations where id=?').bind(operation.id).first()).toEqual(before);
    const result = (await conversations.readConversation(f.db, f.task, { archive: true }))!.messages.at(-1)!.message;
    if (result.role !== 'toolResult') throw new Error('Expected persisted tool result');
    expect(result.content[0].type === 'text' && JSON.parse(result.content[0].text)).toMatchObject({ effects: 'unknown', receipt: output });
  });

  it('finishes an actual legacy stuck command with an empty predecessor and matching pending identity', async () => {
    const f = await fixture(true);
    await pending(f, 'unknown');
    await f.db.prepare('insert into agent_runtime_commands(command_id,task_id,command,created_at) values(?,?,?,?)')
      .bind('cancel',f.task.id,'cancel',new Date().toISOString()).run();
    // This is the old failure state: safety barrier committed, no final receipt.
    await f.db.prepare("update agent_tasks set status='cancelled',outcome='cancelled',pending_command_id=case when id=? then 'cancel' else '' end")
      .bind(f.task.id).run();
    expect(await f.db.prepare('select predecessor_json from agent_runtime_commands').first('predecessor_json')).toBe('{}');
    await executeTaskCommand(f.host, f.input);
    expect((await currentExecution(f.db, 'parent'))?.status).toBe('cancelled');
    expect((await currentExecution(f.db, 'child'))?.status).toBe('cancelled');
    expect(f.terminate).toHaveBeenCalledTimes(2);
    await executeTaskCommand(f.host, f.input);
    expect(f.terminate).toHaveBeenCalledTimes(2);
  });

  it('does not bootstrap an unrelated legacy command or grant an old execution controller authority', async () => {
    const f = await fixture();
    await pending(f, 'unknown');
    await f.db.prepare('insert into agent_runtime_commands(command_id,task_id,command,created_at) values(?,?,?,?)')
      .bind('cancel',f.task.id,'cancel',new Date().toISOString()).run();
    await f.db.prepare("update agent_tasks set status='cancelled',pending_command_id='other-command' where id=?").bind(f.task.id).run();
    await expect(executeTaskCommand(f.host, f.input)).rejects.toThrow('scope is stale');
    await expect(executeTaskCommand(f.env, f.input)).rejects.toThrow('controller authority');
    expect(await f.db.prepare('select predecessor_json from agent_runtime_commands').first('predecessor_json')).toBe('{}');
    expect(f.terminate).not.toHaveBeenCalled();
  });

  it('cancels the same Task when a real execution handoff wins immediately before the barrier', async () => {
    const f = await fixture();
    await pending(f, 'running');
    let injected = false;
    const db = new Proxy(f.db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        const wrap = (current: typeof statement): typeof statement => new Proxy(current, { get(inner, method) {
          if (method === 'bind') return (...values: Parameters<typeof inner.bind>) => wrap(inner.bind(...values));
          if (method === 'run' && sql.includes("'$.cancellation.token',?,'$.cancellation.leaseUntil',?")) return async () => {
            const result = await inner.run();
            if (!injected && result.meta.changes) {
              injected = true;
              const next = await createRuntimeExecution(f.db, f.run.id, f.execution, 'race_before_cancel_barrier');
              await activateRuntimeExecution(f.db, authorityForExecution(next), next.workflow_id);
            }
            return result;
          };
          const value = Reflect.get(inner, method);
          return typeof value === 'function' ? value.bind(inner) : value;
        } });
        return wrap(statement);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await executeTaskCommand({ ...f.host, DB: db }, f.input);
    expect(injected).toBe(true);
    expect(await taskForRun(f.db, f.run.id)).toMatchObject({ status: 'cancelled', epoch: 2 });
    expect(await currentExecution(f.db, f.run.id)).toMatchObject({ status: 'cancelled', epoch: 2 });
    expect(f.terminate.mock.calls).toEqual([['wf_parent_2']]);
    const state = JSON.parse(await f.db.prepare('select predecessor_json from agent_runtime_commands').first<string>('predecessor_json') || '{}');
    expect(state.cancellation.controller.epoch).toBe(2);
  });
});
