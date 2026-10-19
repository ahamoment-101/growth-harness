import { describe, expect, it, vi } from 'vitest';
import { taskTestDb } from './task-test-db';
import { attachTask, taskForRun, prepareTaskModel } from './task-store';
import { agentDefinition } from './definitions';
import { recordExecutionFailure, reconcileTaskExecutions, taskExecutionView } from './task-recovery';
import { executionFailure, type ExecutionFailure } from './execution-failure';
import { executionEnvironment } from './execution-context';
import { activateRuntimeExecution, createRuntimeExecution, currentExecution, authorityForExecution } from './runtime-executions';
import type { RuntimeAgentEnv } from './env';
const failure: ExecutionFailure = { origin: 'upstream', scope: 'request', recovery_action: 'retry_request', message: 'fetch failed', status: 0, request_id: '', stage: 'conversation' };
const at = new Date('2026-09-08T00:00:00Z');
async function fixture() {
  const f = taskTestDb(); const run = f.run(); const task = await attachTask(f.db, run, agentDefinition('strategy_research'));
  const execution = await createRuntimeExecution(f.db, run.id);
  await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  let status = 'complete';
  const create = vi.fn(async (value: {id:string}) => ({ id:value.id }));
  const env = { DB:f.db, AGENT_RUNTIME_ENABLED:'true', AGENT_WORKFLOW:{ create, get:async () => ({status:async () => ({status})}) } } as unknown as RuntimeAgentEnv;
  return {...f, task, run, execution, env, scoped:executionEnvironment(env, authorityForExecution(execution)), create, hostStatus:(value:string)=>{status=value;}};
}
describe('continuous execution recovery', () => {
  it('repairs a committed terminal checkpoint after the host lost its final projection', async () => {
    const f=await fixture();
    await f.db.prepare("update agent_tasks set status='completed',outcome='partial',reason='Saved before crash',output_json=? where id=?").bind(JSON.stringify({artifact_refs:['saved-artifact'],unresolved_issues:['evidence gap']}),f.task.id).run();
    await reconcileTaskExecutions(f.env,new Date('2030-01-01'));
    expect((await f.db.prepare('select status,output_json from agent_runs where id=?').bind(f.run.id).first())).toMatchObject({status:'succeeded',output_json:JSON.stringify({artifact_refs:['saved-artifact'],unresolved_issues:['evidence gap']})});
    expect((await currentExecution(f.db,f.run.id))?.status).toBe('finished');
    expect(f.create).not.toHaveBeenCalled();
    await reconcileTaskExecutions(f.env,new Date('2030-01-02'));
    expect(await f.db.prepare('select count(*) as n from agent_runtime_executions').first('n')).toBe(1);
    expect(await f.db.prepare("select count(*) as n from agent_events where event_key like '%checkpoint'").first('n')).toBe(1);
  });

  it('persists a backoff once, fences the failed host and recovers the original R1', async () => {
    const f = await fixture();
    await f.db.prepare("update agent_tasks set workspace_json='{\"kept\":true}',model_calls=7,reserved_tokens=1200").run();
    await recordExecutionFailure(f.scoped,f.run.id,failure,at);
    await recordExecutionFailure(f.scoped,f.run.id,failure,at);
    await expect(f.scoped.DB.prepare("update agent_tasks set reason='late'").run()).rejects.toThrow('authority lost');
    expect(await taskExecutionView(f.db,(await taskForRun(f.db,f.run.id))!)).toMatchObject({execution_state:'recovering',allowed_actions:['cancel']});
    await reconcileTaskExecutions(f.env,new Date(at.getTime()+61000));
    expect(await taskForRun(f.db,f.run.id)).toMatchObject({id:f.task.id,active_run_id:f.run.id,epoch:2,workspace_json:'{"kept":true}',model_calls:7,reserved_tokens:1200});
    expect(await f.db.prepare('select count(*) as n from agent_runs').first('n')).toBe(1);
  });
  it('automatically resumes caught CPU exhaustion only after backoff and host closure, retaining the same task and run', async () => {
    const f = await fixture();
    await f.db.prepare("update agent_tasks set workspace_json='{\"saved\":true}',model_calls=7").run();
    await recordExecutionFailure(f.scoped, f.run.id, executionFailure(new Error('Worker exceeded CPU time limit.'), 'conversation')!, at);
    expect(await taskExecutionView(f.db, (await taskForRun(f.db, f.run.id))!)).toMatchObject({ execution_state: 'recovering', allowed_actions: ['cancel'] });
    await reconcileTaskExecutions(f.env, new Date(at.getTime() + 30000));
    expect(f.create).not.toHaveBeenCalled();
    f.hostStatus('running');
    await reconcileTaskExecutions(f.env, new Date(at.getTime() + 61000));
    expect(f.create).not.toHaveBeenCalled();
    f.hostStatus('complete');
    await reconcileTaskExecutions(f.env, new Date(at.getTime() + 121000));
    expect(await taskForRun(f.db, f.run.id)).toMatchObject({ id: f.task.id, active_run_id: f.run.id, epoch: 2, status: 'running', workspace_json: '{"saved":true}', model_calls: 7 });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(await f.db.prepare('select count(*) n from agent_runs').first('n')).toBe(1);
  });
  it('also replaces a platform-terminated host without a caught failure checkpoint', async () => {
    const f = await fixture();
    f.hostStatus('errored');
    await reconcileTaskExecutions(f.env, at);
    expect(await taskForRun(f.db, f.run.id)).toMatchObject({ id: f.task.id, active_run_id: f.run.id, epoch: 2, status: 'running' });
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('does not replay an unknown tool effect after caught CPU exhaustion', async () => {
    const f = await fixture();
    await f.db.prepare("insert into agent_task_operations(id,task_id,turn,status,context_json,created_at,updated_at) values('cpu-op',?,1,'unknown','{}','now','now')").bind(f.task.id).run();
    await recordExecutionFailure(f.scoped, f.run.id, executionFailure(new Error('Worker exceeded CPU time limit.'))!, at);
    await reconcileTaskExecutions(f.env, new Date(at.getTime() + 61000));
    expect(await taskForRun(f.db, f.run.id)).toMatchObject({ status: 'paused', outcome: 'external_pending' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('keeps an explicit provider protocol rejection visible without automatic repeated requests', async () => {
    const f=await fixture();
    await recordExecutionFailure(f.scoped,f.run.id,{...failure,recovery_action:'pause',status:400,message:'Unsupported provider request'},at);
    await reconcileTaskExecutions(f.env,new Date('2030-01-01'));
    expect(await taskForRun(f.db,f.run.id)).toMatchObject({status:'paused',reason:'Unsupported provider request'});
    expect(f.create).not.toHaveBeenCalled();
  });
  it('preserves an unknown physical request and charges before issuing a new execution', async () => {
    const f = await fixture();
    await prepareTaskModel(f.scoped.DB,{runId:f.run.id,reservationId:'physical-1',operationId:'decision-1',tokens:100,request:{prompt:'saved'},reusePredecessor:true});
    await f.db.prepare("insert into agent_model_attempts(id,run_id,purpose,decision_turn,attempt,provider,model,status,created_at) values('lost-trace',?,'conversation::physical-1',1,1,'test','test','running','now')").bind(f.run.id).run();
    await reconcileTaskExecutions(f.env,at);
    expect(await f.db.prepare('select status,outcome_state,tokens from agent_task_model_reservations').first()).toEqual({status:'failed',outcome_state:'unknown',tokens:100});
    expect((await currentExecution(f.db,f.run.id))?.epoch).toBe(2);
    expect(await f.db.prepare("select status,error_kind from agent_model_attempts where id='lost-trace'").first()).toEqual({status:'failed',error_kind:'outcome_unknown'});
  });
  it('recovers a paused missing model receipt only after verifying that its host has closed', async () => {
    const f=await fixture();
    await prepareTaskModel(f.scoped.DB,{runId:f.run.id,reservationId:'stalled-stream',operationId:'compact',tokens:100,request:{prompt:'saved'},reusePredecessor:true});
    await f.db.prepare("update agent_tasks set status='paused',outcome='execution_failed'").run();
    await f.db.prepare("update agent_runtime_executions set status='waiting'").run();
    f.hostStatus('running');await reconcileTaskExecutions(f.env,at);
    expect(f.create).not.toHaveBeenCalled();
    f.hostStatus('complete');await reconcileTaskExecutions(f.env,at);
    expect(await taskForRun(f.db,f.run.id)).toMatchObject({id:f.task.id,active_run_id:f.run.id,epoch:2,status:'running'});
    expect(await f.db.prepare('select id,status,outcome_state from agent_task_model_reservations').first()).toEqual({id:'stalled-stream',status:'failed',outcome_state:'unknown'});
  });
  it('keeps unknown mutation effects waiting for reconciliation and never resubmits them', async () => {
    const f = await fixture();
    await f.db.prepare("insert into agent_task_operations(id,task_id,turn,status,context_json,created_at,updated_at) values('op',?,1,'unknown','{}','now','now')").bind(f.task.id).run();
    await reconcileTaskExecutions(f.env,at);
    expect(await taskForRun(f.db,f.run.id)).toMatchObject({status:'paused',outcome:'external_pending'});
    expect(f.create).not.toHaveBeenCalled();
  });
  it('does not take over a live host or a cancelled task', async () => {
    const f = await fixture();f.hostStatus('running');
    await reconcileTaskExecutions(f.env,at);expect(f.create).not.toHaveBeenCalled();
    f.hostStatus('complete');await f.db.prepare("update agent_tasks set status='cancelled'").run();
    await reconcileTaskExecutions(f.env,at);expect(f.create).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent host replacement and tolerates a lost create response', async () => {
    const f = await fixture();
    f.create.mockImplementation(async () => { throw new Error('create response lost'); });
    await Promise.all([reconcileTaskExecutions(f.env,at),reconcileTaskExecutions(f.env,at)]);
    expect(await f.db.prepare('select count(*) as n from agent_runtime_executions').first('n')).toBe(2);
    expect(new Set(f.create.mock.calls.map(call=>call[0].id)).size).toBe(1);
    expect((await currentExecution(f.db,f.run.id))?.epoch).toBe(2);
  });
  it('does not impose a no-progress recovery quota on an unavailable provider', async () => {
    const f = await fixture();
    for(let index=0;index<6;index++) {
      const execution=(await currentExecution(f.db,f.run.id))!;
      await activateRuntimeExecution(f.db,authorityForExecution(execution),execution.workflow_id);
      await recordExecutionFailure(executionEnvironment(f.env,authorityForExecution(execution)),f.run.id,failure,at);
      await reconcileTaskExecutions(f.env,new Date(at.getTime()+61000));
    }
    expect((await currentExecution(f.db,f.run.id))?.epoch).toBe(7);
    expect((await taskForRun(f.db,f.run.id))?.status).toBe('running');
  });
});
