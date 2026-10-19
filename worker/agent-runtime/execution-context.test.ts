import { describe, expect, it } from 'vitest';
import { taskTestDb } from './task-test-db';
import { attachTask, requireTask } from './task-store';
import { agentDefinition } from './definitions';
import { executionDatabase } from './execution-context';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution } from './runtime-executions';

async function fixture() {
  const state = taskTestDb();
  const task = await attachTask(state.db, state.run(), agentDefinition('strategy_research'));
  const execution = await createRuntimeExecution(state.db, task.active_run_id);
  const authority = authorityForExecution(execution);
  await activateRuntimeExecution(state.db, authority, execution.workflow_id);
  return { ...state, task, execution, scoped: executionDatabase(state.db, authority) };
}
describe('continuous Runtime execution authority', () => {
  it('keeps one Run during handoff and rejects every stale effect without partial writes', async () => {
    const f = await fixture();
    await f.scoped.prepare("update agent_tasks set reason='first' where id=?").bind(f.task.id).run();
    const next = await createRuntimeExecution(f.db, f.task.active_run_id, f.execution, 'capacity');
    await activateRuntimeExecution(f.db, authorityForExecution(next), next.workflow_id);
    expect(next.run_id).toBe(f.execution.run_id);
    await expect(requireTask(f.scoped, next.run_id)).rejects.toThrow('stale');
    await expect(f.scoped.batch([
      f.scoped.prepare("update agent_tasks set reason='late' where id=?").bind(f.task.id),
      f.scoped.prepare("update agent_runs set phase='late' where id=?").bind(next.run_id),
    ])).rejects.toThrow('authority lost');
    expect(await f.db.prepare('select reason from agent_tasks').first('reason')).toBe('');
    expect(await f.db.prepare('select count(*) as n from agent_runs').first('n')).toBe(1);
    expect(await f.db.prepare('select count(*) as n from agent_task_runs').first('n')).toBe(1);
  });

  it('rejects a second Run association and a mismatched Execution in the database itself', async () => {
    const f = await fixture();
    const other = f.run('other');
    await expect(f.db.prepare('update agent_tasks set active_run_id=? where id=?').bind(other.id, f.task.id).run()).rejects.toThrow('immutable');
    await expect(f.db.prepare('insert into agent_task_runs(run_id,task_id,epoch) values(?,?,1)').bind(other.id, f.task.id).run()).rejects.toThrow('exactly one');
    await expect(f.db.prepare("insert into agent_runtime_executions(id,task_id,run_id,epoch,workflow_id,status,created_at,updated_at) values('bad',?,?,2,'bad','dispatching','','')").bind(f.task.id, other.id).run()).rejects.toThrow('Task Run');
  });

  it('allows a child while its parent waits and fences it immediately when an ancestor closes', async () => {
    const f = await fixture();
    const childRun = { ...f.run('child', 'child'), parent_run_id: f.task.active_run_id };
    const child = await attachTask(f.db, childRun, agentDefinition('strategy_research'));
    const execution = await createRuntimeExecution(f.db, child.active_run_id);
    await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
    const db = executionDatabase(f.db, authorityForExecution(execution));
    await f.db.prepare("update agent_tasks set status='waiting' where id=?").bind(f.task.id).run();
    await expect(requireTask(db, child.active_run_id)).resolves.toMatchObject({ id: child.id });
    await db.prepare("update agent_tasks set reason='child progress' where id=?").bind(child.id).run();
    await f.db.prepare("update agent_tasks set status='completed' where id=?").bind(f.task.id).run();
    await expect(db.prepare("update agent_tasks set reason='late' where id=?").bind(child.id).run()).rejects.toThrow('ancestor closed');
    expect(await f.db.prepare('select reason from agent_tasks where id=?').bind(child.id).first('reason')).toBe('child progress');
  });

  it('does not revive a cancelled task or authorize a second epoch from stale controller state', async () => {
    const f = await fixture();
    const next = await createRuntimeExecution(f.db, f.task.active_run_id, f.execution);
    const again = await createRuntimeExecution(f.db, f.task.active_run_id, f.execution);
    expect(again.id).toBe(next.id);
    await f.db.prepare("update agent_tasks set status='cancelled' where id=?").bind(f.task.id).run();
    await expect(createRuntimeExecution(f.db, f.task.active_run_id, next)).rejects.toThrow('closed');
    await expect(f.scoped.prepare("update agent_tasks set status='running' where id=?").bind(f.task.id).run()).rejects.toThrow('authority lost');
  });
});
