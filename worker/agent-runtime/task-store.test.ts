import { describe, expect, it } from 'vitest';
import { agentDefinition } from './definitions';
import { taskTestDb, resumeTestTask } from './task-test-db';
import { settleTaskModel, finishTaskTerminal, attachTask, beginTaskDecision, finishTaskOperation, readTaskOperation, requireTask, reserveTaskModel, setTaskAction, stopTask, taskForRun, writeTaskWorkspace } from './task-store';
const definition = agentDefinition('strategy_research');
describe('durable task state', () => {
  it('resumes the same task without resetting workspace, decisions or budgets', async () => {
    const { db, run } = taskTestDb();
    const first = run(); const task = await attachTask(db, first, definition);
    const operation = await beginTaskDecision(db, task, { prompt: 'original' });
    await setTaskAction(db, task, operation, { name: 'write' });
    await writeTaskWorkspace(db, task, operation, 0, { text: 'saved' });
    await finishTaskOperation(db, task, operation, { revision: 1 });
    await reserveTaskModel(db, task, 'attempt-1', 100);
    await stopTask(db, first.id, 'paused', 'temporary interruption');
    const next = await resumeTestTask(db, first.id);
    expect(next).toMatchObject({ id: first.id, revision: 1, next_turn: 2, reserved_tokens: 100, model_calls: 1, epoch: 2 });
    expect(JSON.parse(next.workspace_json)).toEqual({ text: 'saved' });
    expect(next.active_run_id).toBe(first.id);
    expect(await db.prepare('select count(*) as n from agent_runs').first('n')).toBe(1);
  });
  it('round-trips a multi-megabyte draft and result through content references without truncating either', async () => {
    const {db,run}=taskTestDb();const task=await attachTask(db,run(),definition);
    const operation=await beginTaskDecision(db,task,{});
    const draft={markdown:'Raw facts 🙂\n'.repeat(150000)};
    await writeTaskWorkspace(db,task,operation,0,draft,{saved:draft});
    expect(JSON.parse((await requireTask(db,task.active_run_id)).workspace_json)).toEqual(draft);
    expect(JSON.parse((await readTaskOperation(db,task.id,1))!.output_json).saved).toEqual(draft);
    const stored=await db.prepare('select workspace_json from agent_tasks').first<string>('workspace_json');
    expect(stored!.length).toBeLessThan(300);
    await stopTask(db,task.active_run_id,'completed','Saved','completed',draft);
    expect(JSON.parse((await taskForRun(db,task.active_run_id))!.output_json)).toEqual(draft);
  });
  it('keeps the original decision snapshot on replay', async () => {
    const { db, run } = taskTestDb(); const task = await attachTask(db, run(), definition);
    await beginTaskDecision(db, task, { prompt: 'original' });
    const replay = await beginTaskDecision(db, task, { prompt: 'changed' });
    expect(JSON.parse(replay.context_json)).toEqual({ prompt: 'original' });
  });
  it('rejects stale workspace writes and prevents an old operation overwriting newer work', async () => {
    const { db, run } = taskTestDb(); const task = await attachTask(db, run(), definition);
    const first = await beginTaskDecision(db, task, {});
    await writeTaskWorkspace(db, task, first, 0, { v: 1 });
    await finishTaskOperation(db, task, first, { revision: 1 });
    const current = await requireTask(db, task.active_run_id);
    const second = await beginTaskDecision(db, current, {});
    await expect(writeTaskWorkspace(db, current, second, 0, { v: 'stale' })).rejects.toThrow('Workspace changed');
    await writeTaskWorkspace(db, current, second, 1, { v: 2 });
    await writeTaskWorkspace(db, task, first, 0, { v: 'old replay' });
    expect(JSON.parse((await requireTask(db, task.active_run_id)).workspace_json)).toEqual({ v: 2 });
  });
  it('fences old executors after cancellation and prevents cancelled tasks resuming', async () => {
    const { db, run } = taskTestDb(); const task = await attachTask(db, run(), definition);
    const operation = await beginTaskDecision(db, task, {});
    await stopTask(db, task.active_run_id, 'cancelled', 'user cancelled');
    await expect(writeTaskWorkspace(db, task, operation, 0, { invalid: true })).rejects.toThrow();
    await expect(attachTask(db, run('run-2'), definition, task.active_run_id)).rejects.toThrow('original Run');
    expect((await taskForRun(db, task.active_run_id))?.status).toBe('cancelled');
  });
  it('does not let a new execution inherit a different language task', async () => {
    const { db, run } = taskTestDb(); const task = await attachTask(db, run(), definition);
    await stopTask(db, task.active_run_id, 'paused', 'wait');
    await expect(attachTask(db, run('run-ja', 'strategy:ja'), definition, task.active_run_id)).rejects.toThrow('original Run');
  });
  it('records cumulative usage atomically without imposing a lifetime ceiling', async () => {
    const { db, run } = taskTestDb(); const task = await attachTask(db, run(), definition);
    await reserveTaskModel(db, task, 'a', 80);
    await reserveTaskModel(db, task, 'a', 80);
    await reserveTaskModel(db, task, 'b', 30);
    expect(await requireTask(db, task.active_run_id)).toMatchObject({ reserved_tokens: 110, model_calls: 2 });
  });
  it('advances past a failed tool and preserves its failure as an observation', async () => {
    const { db, run } = taskTestDb(); const task = await attachTask(db, run(), definition);
    const operation = await beginTaskDecision(db, task, {});
    await finishTaskOperation(db, task, operation, { failure_kind: 'transient' }, 'temporary failure');
    expect((await requireTask(db, task.active_run_id)).next_turn).toBe(2);
    expect(await readTaskOperation(db, task.id, 1)).toMatchObject({ status: 'failed', error: 'temporary failure' });
  });
  it('commits the terminal receipt and cursor together, fencing late cancellation', async () => {
    const { db, run } = taskTestDb(); const task = await attachTask(db, run(), definition);
    const operation = await beginTaskDecision(db, task, {});
    await finishTaskTerminal(db, task, operation, { status: 'completed', outcome: 'no_change', reason: 'Existing strategy is sufficient', output: { kept: true } });
    expect(await stopTask(db, task.active_run_id, 'cancelled', 'late cancel')).toBe(false);
    expect(await taskForRun(db, task.active_run_id)).toMatchObject({ status: 'completed', next_turn: 2, outcome: 'no_change' });
    expect(await readTaskOperation(db, task.id, 1)).toMatchObject({ status: 'succeeded', output_json: '{"kept":true}' });
  });
  it('settles actual model usage once and preserves the cached response', async () => {
    const { db, run } = taskTestDb(); const task = await attachTask(db, run(), definition);
    await reserveTaskModel(db, task, 'a', 1000);
    await settleTaskModel(db, 'a', { toolCalls: [] }, 25);
    await settleTaskModel(db, 'a', { wrong: true }, 500);
    expect(await taskForRun(db, task.active_run_id)).toMatchObject({ reserved_tokens: 25, model_calls: 1 });
    expect(await db.prepare('select response_json from agent_task_model_reservations where id = ?').bind('a').first()).toEqual({ response_json: '{"toolCalls":[]}' });
  });
  it('does not mutate workspace through a failed operation or overwrite its receipt', async () => {
    const { db, run } = taskTestDb(); const task = await attachTask(db, run(), definition);
    const operation = await beginTaskDecision(db, task, {});
    await finishTaskOperation(db, task, operation, { failed: true }, 'failed');
    await expect(writeTaskWorkspace(db, task, operation, 0, { invalid: true })).rejects.toThrow();
    await finishTaskOperation(db, task, operation, { overwritten: true });
    expect(await readTaskOperation(db, task.id, 1)).toMatchObject({ status: 'failed', output_json: '{"failed":true}' });
    expect((await taskForRun(db, task.active_run_id))?.revision).toBe(0);
  });

});
