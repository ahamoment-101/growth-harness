import { describe, expect, it, vi } from 'vitest';
vi.mock('./run-lifecycle', () => ({ reconcileCancelledAgentRun: vi.fn() }));
import { executeTaskCommand, recoverTaskCommand, taskCommandRunId } from './task-commands';
import { taskTestDb } from './task-test-db';
import { attachTask, beginTaskDecision, finishTaskTerminal, stopTask, taskForRun } from './task-store';
import { agentDefinition } from './definitions';
import type { RuntimeAgentEnv } from './env';
const definition = agentDefinition('strategy_research');
describe('task commands', () => {
  it.each([true,false])('preserves failed descendants during manual parent cancellation (already projected: %s)', async projected => {
    const {db,run} = taskTestDb();
    const parent = run(); await attachTask(db,parent,definition);
    const child = {...run('failed-child','failed-child'),parent_run_id:parent.id,workflow_id:'failed-host'};
    await db.prepare('update agent_runs set parent_run_id=?,workflow_id=? where id=?').bind(parent.id,child.workflow_id,child.id).run();
    await attachTask(db,child,definition);
    await stopTask(db,child.id,'failed','Original failure','failed',{reason:'Original failure'});
    if (projected) await db.prepare("update agent_runs set status='failed',phase='failed',finished_at='original-finish',updated_at='original-update',error='Original failure' where id=?").bind(child.id).run();
    const savedTask = await taskForRun(db,child.id);
    const savedRun = await db.prepare('select * from agent_runs where id=?').bind(child.id).first();
    const terminate = vi.fn(async () => {});
    await executeTaskCommand({DB:db,AGENT_WORKFLOW:{get:async()=>({terminate,status:async()=>({status:terminate.mock.calls.length?'terminated':'running'})})}} as unknown as RuntimeAgentEnv,
      {run:parent,command:'cancel',commandId:'cancel-parent-preserve',actorId:'u',reason:'User stopped parent'});
    expect(await taskForRun(db,child.id)).toEqual(savedTask);
    const finalRun = await db.prepare('select * from agent_runs where id=?').bind(child.id).first();
    if (projected) expect(finalRun).toEqual(savedRun);
    else expect(finalRun).toMatchObject({status:'failed',phase:'failed',execution_outcome:'failed',output_json:savedTask!.output_json,finished_at:savedTask!.updated_at});
    expect(terminate).toHaveBeenCalledOnce();
  });
  it('cancels a waiting task even though its last Run succeeded, surviving cleanup failure', async () => {
    const { db, run } = taskTestDb(); const execution = run(); const task = await attachTask(db, execution, definition);
    await stopTask(db, execution.id, 'waiting', 'need input');
    await db.prepare("update agent_runs set status='succeeded',workflow_id='wf' where id=?").bind(execution.id).run();
    const terminate = vi.fn(async () => {});
    const get = vi.fn().mockRejectedValueOnce(new Error('cleanup unavailable')).mockResolvedValue({ terminate, status: async () => ({ status: terminate.mock.calls.length ? 'terminated' : 'running' }) });
    const env = { DB: db, AGENT_WORKFLOW: { get } } as unknown as RuntimeAgentEnv;
    const input = { run: { ...execution, workflow_id: 'wf', status: 'succeeded' as const }, command: 'cancel', commandId: 'cancel-1', actorId: 'u', reason: 'cancel' };
    await expect(executeTaskCommand(env, input)).rejects.toThrow('cleanup remains pending');
    expect((await taskForRun(db, execution.id))?.status).toBe('cancelled');
    expect((await recoverTaskCommand(env, input))?.task?.id).toBe(task.id);
    expect(terminate).toHaveBeenCalledOnce();
  });
  it('cancels child tasks even if their workflow cleanup is unavailable', async () => {
    const { db, run } = taskTestDb(); const parentRun = run(); await attachTask(db, parentRun, definition);
    const childRun = { ...run('child', 'research-child'), agent_id: 'deep_research' as const, parent_run_id: parentRun.id, workflow_id: 'wf_child' };
    await db.prepare('update agent_runs set agent_id=?,parent_run_id=?,workflow_id=? where id=?').bind('deep_research', parentRun.id, 'wf_child', childRun.id).run();
    await attachTask(db, childRun, agentDefinition('deep_research'));
    const cleanup = vi.fn(async () => { throw new Error('network unavailable'); });
    await expect(executeTaskCommand({ DB: db, AGENT_WORKFLOW: { get: cleanup } } as unknown as RuntimeAgentEnv,
      { run: parentRun, command: 'cancel', commandId: 'tree-cancel', actorId: 'u', reason: 'stop' })).rejects.toThrow('cleanup remains pending');
    expect((await taskForRun(db, childRun.id))?.status).toBe('cancelled');
    expect(cleanup).toHaveBeenCalledWith('wf_child');
  });
  it('refuses a cancellation that loses to task completion', async () => {
    const { db, run } = taskTestDb(); const execution = run(); const task = await attachTask(db, execution, definition);
    const operation = await beginTaskDecision(db, task, {});
    await finishTaskTerminal(db, task, operation, { status: 'completed', outcome: 'no_change', reason: '', output: {} });
    await expect(executeTaskCommand({ DB: db } as RuntimeAgentEnv, { run: execution, command: 'cancel', commandId: 'c', actorId: 'u', reason: '' })).rejects.toThrow('closed');
    expect((await taskForRun(db, execution.id))?.status).toBe('completed');
  });
  it('replays an interrupted resume command without allocating another execution or input', async () => {
    const {db,run}=taskTestDb();const original=run();await attachTask(db,original,definition);
    await stopTask(db,original.id,'waiting','Need confirmed fact');
    const create=vi.fn().mockRejectedValueOnce(new Error('Creation response lost')).mockResolvedValue({id:'saved-workflow'});
    const env={DB:db,AGENT_RUNTIME_ENABLED:'true',AGENT_WORKFLOW:{create,get:async()=>{throw new Error('Lookup unavailable');}}} as unknown as RuntimeAgentEnv;
    const command={run:original,command:'provide_input',commandId:'durable-command',actorId:'u',reason:'',value:'Confirmed fact'};
    await expect(executeTaskCommand(env,command)).rejects.toThrow('Creation response lost');
    const resumed=await executeTaskCommand(env,command);
    expect(resumed.run.id).toBe(original.id);
    expect(await db.prepare('select count(*) as n from agent_runtime_executions').first('n')).toBe(1);
    expect(await db.prepare('select count(*) as n from agent_task_inputs').first('n')).toBe(1);
    expect(await executeTaskCommand(env,command)).toEqual(resumed);
    expect(create).toHaveBeenCalledTimes(2);
    expect(new Set(create.mock.calls.map(call=>call[0].id)).size).toBe(1);
  });
  it('persists user input before resuming the same task and uses a bounded collision-resistant execution ID', async () => {
    const { db, run } = taskTestDb(); const execution = run(); await attachTask(db, execution, definition);
    await stopTask(db, execution.id, 'waiting', 'need input');
    const create = vi.fn(async (value: { id: string }) => {
      expect(await db.prepare('select content from agent_task_inputs where id=?').bind('a:b').first('content')).toBe('Confirmed brief');
      return { id: value.id };
    });
    const result = await executeTaskCommand({ DB: db, AGENT_RUNTIME_ENABLED: 'true', AGENT_WORKFLOW: { create } } as unknown as RuntimeAgentEnv, { run: execution, command: 'provide_input', commandId: 'a:b', actorId: 'u', reason: '', value: 'Confirmed brief' });
    expect(result.task?.id).toBe(execution.id);
    expect(result.run.id).toBe(execution.id);
    expect(await db.prepare('select count(*) as n from agent_runs').first('n')).toBe(1);
    expect(await taskCommandRunId('a:b')).not.toBe(await taskCommandRunId('ab'));
    expect(await taskCommandRunId('x'.repeat(5000))).toHaveLength(77);
  });
});
