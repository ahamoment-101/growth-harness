import { expect, it, vi } from 'vitest';
import { taskTestDb } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, stopTask, taskForRun } from './task-store';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution } from './runtime-executions';
import { executionEnvironment } from './execution-context';
import { closeDescendantSessions } from './task-descendants';
import type { RuntimeAgentEnv } from './env';
import { saveSlot, resolveSlot } from './parameter-slots';
import { settleRuntimeCheckpoint } from './runtime-checkpoint';
import { taskExecutionView } from './task-recovery';
import { executeTaskCommand } from './task-commands';

async function descendantsFixture(agentId: 'deep_research' | 'article_production' = 'deep_research') {
  const f = taskTestDb();
  const parent = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const owner = await createRuntimeExecution(f.db, parent.id);
  await activateRuntimeExecution(f.db, authorityForExecution(owner), owner.workflow_id);
  const run = { ...f.run('child', 'child'), agent_id: agentId, parent_run_id: parent.id };
  await f.db.prepare('update agent_runs set agent_id=?,parent_run_id=? where id=?').bind(agentId,parent.id,run.id).run();
  const child = await attachTask(f.db, run, agentDefinition(agentId));
  const execution = await createRuntimeExecution(f.db, child.id);
  await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  const terminate = vi.fn(async () => undefined);
  const env = { DB: f.db, AGENT_WORKFLOW: { get: async () => ({ terminate, sendEvent: async () => {} }) } } as unknown as RuntimeAgentEnv;
  return { ...f, parent, owner, child, execution, env, terminate };
}

it.each(['deep_research','article_production'] as const)('preserves terminal %s receipts and timestamps across parent checkpoint replay', async agentId => {
  for (const status of ['completed','failed','cancelled'] as const) {
    const f = await descendantsFixture(agentId);
    await stopTask(f.db,f.child.id,status,'Original reason',status,{reason:'Original reason',artifact_id:'saved'});
    await settleRuntimeCheckpoint(f.env,authorityForExecution(f.execution));
    const task = await taskForRun(f.db,f.child.id);
    const run = await f.db.prepare('select * from agent_runs where id=?').bind(f.child.id).first();
    await stopTask(f.db,f.parent.id,'completed','Parent finished');
    await settleRuntimeCheckpoint(f.env,authorityForExecution(f.owner));
    await settleRuntimeCheckpoint(f.env,authorityForExecution(f.owner));
    expect(await taskForRun(f.db,f.child.id)).toEqual(task);
    expect(await f.db.prepare('select * from agent_runs where id=?').bind(f.child.id).first()).toEqual(run);
    expect((await taskExecutionView(f.db,(await taskForRun(f.db,f.child.id))!)).allowed_actions).toEqual([]);
    const childEnv = executionEnvironment(f.env,authorityForExecution(f.execution));
    await expect(childEnv.DB.prepare("update agent_tasks set reason='Late effect' where id=?").bind(f.child.id).run()).rejects.toThrow();
  }
});

it('rejects a resume command for a preserved failed child of a closed parent', async () => {
  const f = await descendantsFixture();
  await stopTask(f.db,f.child.id,'failed','Original failure');
  await stopTask(f.db,f.parent.id,'completed','Parent finished');
  await closeDescendantSessions(f.env,authorityForExecution(f.owner));
  const task = await taskForRun(f.db,f.child.id);
  const run = (await f.db.prepare('select * from agent_runs where id=?').bind(f.child.id).first())!;
  await expect(executeTaskCommand({...f.env,AGENT_RUNTIME_ENABLED:'true'}, {
    run: run as Parameters<typeof executeTaskCommand>[1]['run'],command:'resume',commandId:'resume-closed-child',actorId:'user',reason:'Retry',
  })).rejects.toThrow('ancestor is closed');
  await expect(createRuntimeExecution(f.db,f.child.id,f.execution,'resume')).rejects.toThrow('ancestor is closed');
  expect(await taskForRun(f.db,f.child.id)).toEqual(task);
});

it('atomically rejects execution creation when an ancestor closes after authorization', async () => {
  const f = await descendantsFixture();
  await stopTask(f.db,f.child.id,'failed','Original failure');
  const task = await taskForRun(f.db,f.child.id);
  let interrupted = false;
  const db = new Proxy(f.db, { get(target,key) {
    if (key !== 'batch') return Reflect.get(target,key);
    return async (statements: Parameters<typeof target.batch>[0]) => {
      if (!interrupted) {
        interrupted = true;
        await stopTask(f.db,f.parent.id,'completed','Parent closed during recovery');
      }
      return target.batch(statements);
    };
  } });
  await expect(createRuntimeExecution(db,f.child.id,f.execution,'resume')).rejects.toThrow('predecessor');
  expect(interrupted).toBe(true);
  expect(await taskForRun(f.db,f.child.id)).toEqual(task);
  expect(await f.db.prepare('select count(*) as n from agent_runtime_executions where run_id=?').bind(f.child.id).first()).toEqual({n:1});
});

it('projects a committed failed child when its checkpoint was interrupted and still terminates the host', async () => {
  const f = await descendantsFixture();
  await stopTask(f.db,f.child.id,'failed','Original failure','failed',{reason:'Original failure'});
  const saved = (await taskForRun(f.db,f.child.id))!;
  await stopTask(f.db,f.parent.id,'completed','Parent finished');
  await closeDescendantSessions(f.env,authorityForExecution(f.owner));
  const run = await f.db.prepare('select * from agent_runs where id=?').bind(f.child.id).first();
  expect(run).toMatchObject({status:'failed',phase:'failed',execution_outcome:'failed',finished_at:saved.updated_at,output_json:saved.output_json});
  expect(await taskForRun(f.db,f.child.id)).toEqual(saved);
  expect(f.terminate).toHaveBeenCalledOnce();
  await closeDescendantSessions(f.env,authorityForExecution(f.owner));
  expect(await f.db.prepare('select * from agent_runs where id=?').bind(f.child.id).first()).toEqual(run);
  // The child's checkpoint can arrive after the parent projected its result.
  await settleRuntimeCheckpoint(f.env,authorityForExecution(f.execution));
  const projected = await f.db.prepare('select * from agent_runs where id=?').bind(f.child.id).first();
  expect(projected).toMatchObject({status:'failed',phase:'failed',execution_outcome:'failed',finished_at:saved.updated_at,output_json:saved.output_json,event_seq:1});
  await settleRuntimeCheckpoint(f.env,authorityForExecution(f.execution));
  expect(await f.db.prepare('select * from agent_runs where id=?').bind(f.child.id).first()).toEqual(projected);
});

it.each(['running','paused','waiting'] as const)('closes an unfinished %s child without losing artifacts on replay', async status => {
  const f = await descendantsFixture('article_production');
  if (status !== 'running') await stopTask(f.db,f.child.id,status,'Saved work',status,{artifact_id:'saved'});
  await stopTask(f.db,f.parent.id,'completed','Parent finished');
  await closeDescendantSessions(f.env,authorityForExecution(f.owner));
  const task = await taskForRun(f.db,f.child.id);
  const run = await f.db.prepare('select * from agent_runs where id=?').bind(f.child.id).first();
  expect(task).toMatchObject({status:status==='waiting'?'completed':'cancelled',outcome:status==='waiting'?'parent_closed':'cancelled'});
  if (status !== 'running') expect(task?.output_json).toBe('{"artifact_id":"saved"}');
  await closeDescendantSessions(f.env,authorityForExecution(f.owner));
  expect(await taskForRun(f.db,f.child.id)).toEqual(task);
  expect(await f.db.prepare('select * from agent_runs where id=?').bind(f.child.id).first()).toEqual(run);
});

it('does not let a superseded parent checkpoint close children', async () => {
  const f = await descendantsFixture();
  await stopTask(f.db,f.parent.id,'failed','Recoverable failure');
  const replacement = await createRuntimeExecution(f.db,f.parent.id,f.owner,'resume');
  await activateRuntimeExecution(f.db,authorityForExecution(replacement),replacement.workflow_id);
  await stopTask(f.db,f.parent.id,'completed','Replacement finished');
  const before = await taskForRun(f.db,f.child.id);
  await closeDescendantSessions(f.env,authorityForExecution(f.owner));
  expect(await taskForRun(f.db,f.child.id)).toEqual(before);
  expect(f.terminate).not.toHaveBeenCalled();
});

it('fences cleanup writes when parent authority changes after the initial read', async () => {
  const f = await descendantsFixture();
  await stopTask(f.db,f.parent.id,'failed','Recoverable failure');
  const before = await taskForRun(f.db,f.child.id);
  let interrupted = false;
  const db = new Proxy(f.db, { get(target, key) {
    if (key !== 'prepare') return Reflect.get(target,key);
    return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.includes('update agent_tasks set status=case')) return statement;
      return new Proxy(statement, { get(stmt, method) {
        if (method === 'bind') return (...values: unknown[]) => {
          const bound = stmt.bind(...values);
          return { run: async () => {
            if (!interrupted) {
              interrupted = true;
              const next = await createRuntimeExecution(f.db,f.parent.id,f.owner,'resume');
              await activateRuntimeExecution(f.db,authorityForExecution(next),next.workflow_id);
            }
            return bound.run();
          } };
        };
        return Reflect.get(stmt,method);
      } });
    };
  } });
  await closeDescendantSessions({...f.env,DB:db},authorityForExecution(f.owner));
  expect(interrupted).toBe(true);
  expect(await taskForRun(f.db,f.child.id)).toEqual(before);
  expect(f.terminate).not.toHaveBeenCalled();
});

it('allows children while the parent waits, then closes waiting checkpoints and fences every descendant', async () => {
  const f = taskTestDb();
  const parent = f.run();
  await attachTask(f.db, parent, agentDefinition('strategy_research'));
  const owner = await createRuntimeExecution(f.db, parent.id);
  await activateRuntimeExecution(f.db, authorityForExecution(owner), owner.workflow_id);
  const child = f.run('child', 'child');
  await f.db.prepare('update agent_runs set parent_run_id=? where id=?').bind(parent.id, child.id).run();
  await attachTask(f.db, { ...child, parent_run_id: parent.id }, agentDefinition('strategy_research'));
  const execution = await createRuntimeExecution(f.db, child.id);
  await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  const terminate = vi.fn(async () => undefined);
  const env = { DB: f.db, AGENT_WORKFLOW: { get: async () => ({ terminate }) } } as unknown as RuntimeAgentEnv;
  const childEnv = executionEnvironment(env, authorityForExecution(execution));
  await stopTask(f.db, parent.id, 'waiting', 'Child results');
  const childTask = (await taskForRun(childEnv.DB, child.id))!;
  const ref = await saveSlot(childEnv.DB, childTask, 'candidate', { id: 'observed-candidate' });
  expect(await resolveSlot(childEnv.DB, childTask, ref, 'candidate')).toEqual({ id: 'observed-candidate' });
  await childEnv.DB.prepare("update agent_tasks set reason='Child still progresses' where id=?").bind(child.id).run();
  await stopTask(f.db, child.id, 'waiting', 'Candidate saved', 'submitted', { artifact_id: 'retained-candidate' });
  await f.db.prepare("update agent_tasks set status='completed',outcome='partial' where id=?").bind(parent.id).run();
  await expect(childEnv.DB.prepare("update agent_tasks set reason='Late effect' where id=?").bind(child.id).run()).rejects.toThrow('ancestor closed');
  await closeDescendantSessions(env, authorityForExecution(owner));
  expect(await taskForRun(f.db, child.id)).toMatchObject({ status: 'completed', outcome: 'parent_closed', output_json: '{"artifact_id":"retained-candidate"}' });
  expect(terminate).toHaveBeenCalledOnce();
});
