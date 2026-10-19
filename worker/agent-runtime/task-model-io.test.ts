import { describe, expect, it } from 'vitest';
import { taskTestDb } from './task-test-db';
import { attachTask, commitTaskModel, prepareTaskModel, stopTask, taskForRun } from './task-store';
import { agentDefinition } from './definitions';
async function fixture() {
  const data = taskTestDb(); const parentRun = data.run();
  const parent = await attachTask(data.db,parentRun,agentDefinition('strategy_research'));
  const childRun = {...data.run('child','child'), agent_id:'deep_research',parent_run_id:parentRun.id};
  data.sqlite.prepare("update agent_runs set agent_id='deep_research',parent_run_id=? where id='child'").run(parentRun.id);
  const child = await attachTask(data.db,childRun as never,agentDefinition('deep_research'));
  const input = {runId:child.active_run_id,reservationId:'child:decision:1',operationId:'decision',tokens:100,request:{prompt:'fixture'},reusePredecessor:true};
  return {...data,parent,child,input};
}
describe('atomic model request lifecycle',()=>{
  it('claims only one concurrent request and charges the root once',async()=>{
    const {db,parent,input} = await fixture();
    const results = await Promise.allSettled([prepareTaskModel(db,input),prepareTaskModel(db,input)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const rejected = results.find(r=>r.status==='rejected') as PromiseRejectedResult;
    expect(rejected.reason.message).toContain('outcome is unknown');
    expect((await taskForRun(db,parent.active_run_id))?.model_calls).toBe(1);
  });
  it('preserves and reuses a confirmed result without changing the cumulative budget',async()=>{
    const {db,parent,input} = await fixture();
    await prepareTaskModel(db,input);
    await commitTaskModel(db,input.runId,input.reservationId,{toolCalls:[]},28);
    await commitTaskModel(db,input.runId,input.reservationId,{toolCalls:[]},28);
    expect(await prepareTaskModel(db,input)).toMatchObject({response:'{"toolCalls":[]}',receiptId:input.reservationId});
    expect((await taskForRun(db,parent.active_run_id))?.reserved_tokens).toBe(28);
  });
  it('retains a known incomplete response and allocates a new physical request for the same logical decision',async()=>{
    const {db,sqlite,input} = await fixture();
    await prepareTaskModel(db,input);
    await commitTaskModel(db,input.runId,input.reservationId,{stopReason:'aborted',errorMessage:'request deadline'},28);
    const next={...input,reservationId:'execution-2:decision',excludeFailedAssistant:true};
    expect(await prepareTaskModel(db,next)).toEqual({response:null});
    const rows=sqlite.prepare('select id,status,response_json,operation_id from agent_task_model_reservations order by created_at,id').all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({id:input.reservationId,status:'succeeded',response_json:'{"stopReason":"aborted","errorMessage":"request deadline"}'});
    expect(rows[1]).toMatchObject({id:next.reservationId,status:'running',operation_id:rows[0].operation_id});
  });
  it('does not commit business state after parent cancellation, or release uncertain usage',async()=>{
    const {db,parent,input} = await fixture();
    await prepareTaskModel(db,input);
    await stopTask(db,parent.active_run_id,'cancelled','user');
    await expect(commitTaskModel(db,input.runId,input.reservationId,{},28)).rejects.toThrow('Root task');
    expect((await taskForRun(db,parent.active_run_id))?.reserved_tokens).toBe(100);
  });
  it('does not resend a request whose receipt was lost',async()=>{
    const {db,input} = await fixture();
    await prepareTaskModel(db,input);
    await expect(prepareTaskModel(db,input)).rejects.toThrow('outcome is unknown');
  });
  it('records cumulative consumption without a retired lifetime budget gate',async()=>{
    const {db,sqlite,parent,input} = await fixture();
    sqlite.prepare('update agent_tasks set max_tokens=0 where id=?').run(parent.id);
    await prepareTaskModel(db,input);
    expect((await taskForRun(db,parent.active_run_id))?.model_calls).toBe(1);
  });
});
