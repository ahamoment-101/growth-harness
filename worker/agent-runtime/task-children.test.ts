import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./run-service', () => ({ startRuntimeRun: vi.fn(), dispatchRuntimeWorkflow: vi.fn(async () => 'wf') }));
import { executeChildTask } from './task-children';
import { startRuntimeRun, dispatchRuntimeWorkflow } from './run-service';
import { taskTestDb, resumeTestTask } from './task-test-db';
import { attachTask, beginTaskDecision, stopTask, taskForRun } from './task-store';
import { agentDefinition } from './definitions';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import type { AgentRun } from './protocol';
const step = { do: async (_key: string, config: unknown, fn?: () => Promise<unknown>) => (fn || config as () => Promise<unknown>)(), sleep: async () => {} } as unknown as RuntimeWorkflowStep;
beforeEach(() => vi.clearAllMocks());
describe('durable child task lifecycle', () => {
  it('returns the same child after parent recovery without starting another task', async () => {
    const { db, run } = taskTestDb(); const parentRun = run(); const task = await attachTask(db, parentRun, agentDefinition('strategy_research')); const operation = await beginTaskDecision(db, task, {});
    vi.mocked(startRuntimeRun).mockImplementationOnce(async (_env, request) => {
      const childRun = { ...run(request.runId, request.instanceId), agent_id: 'deep_research', parent_run_id: parentRun.id } as AgentRun;
      await db.prepare('update agent_runs set parent_run_id=?,agent_id=? where id=?').bind(parentRun.id, 'deep_research', childRun.id).run();
      await attachTask(db, childRun, agentDefinition('deep_research'));
      await stopTask(db, childRun.id, 'completed', '', 'partial', { outcome: 'partial' });
      return childRun;
    });
    const input = { env: { DB: db } as RuntimeAgentEnv, step, task, operation, agentId: 'deep_research' as const, summary: { research_question: 'Question', locale: 'en' } };
    const first = (await executeChildTask(input)).task;
    await stopTask(db, parentRun.id, 'paused', 'interrupted');
    const resumed = await resumeTestTask(db,parentRun.id);
    const recovered = (await executeChildTask({ ...input, task: resumed })).task;
    expect(recovered.id).toBe(first.id); expect(recovered.parent_task_id).toBe(task.id);
    expect(startRuntimeRun).toHaveBeenCalledOnce();
  });
  it('recovers a child whose Run was persisted before task attachment or workflow dispatch', async () => {
    const { db, run } = taskTestDb(); const parentRun = run(); const task = await attachTask(db, parentRun, agentDefinition('strategy_research')); const operation = await beginTaskDecision(db, task, {});
    const child = run(`child-${task.id}-${operation.turn}`, 'stable-child');
    await db.prepare('update agent_runs set parent_run_id=?,agent_id=? where id=?').bind(parentRun.id, 'deep_research', child.id).run();
    const create = vi.fn(async () => { await stopTask(db, child.id, 'completed', '', 'partial'); return {id:'wf'}; });
    const result = (await executeChildTask({ env: { DB: db, AGENT_WORKFLOW:{create} } as unknown as RuntimeAgentEnv, step, task, operation, agentId: 'deep_research', summary: {} })).task;
    expect(result.id).toBe(child.id); expect(result.parent_task_id).toBe(task.id);
    expect(startRuntimeRun).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledOnce();
  });
  it('rejects a child identity owned by another task', async () => {
    const { db, run } = taskTestDb(); const task = await attachTask(db, run(), agentDefinition('strategy_research')); const operation = await beginTaskDecision(db, task, {});
    const other = await attachTask(db, run('other', 'other-instance'), agentDefinition('strategy_research'));
    await expect(executeChildTask({ env: { DB: db } as RuntimeAgentEnv, step, task, operation, agentId: 'deep_research', summary: {}, resumeTaskId: other.id })).rejects.toThrow('scope');
    expect((await taskForRun(db, other.id))?.status).toBe('running');
  });
});

describe('child event reconciliation', () => {
  it('observes completion even when the completion event is lost', async () => {
    const { db, run } = taskTestDb(); const parentRun = run(); const task = await attachTask(db, parentRun, agentDefinition('strategy_research')); const operation = await beginTaskDecision(db, task, {});
    const id = `child-${task.id}-${operation.turn}`;
    const childRun = { ...run(id, id), agent_id: 'deep_research', parent_run_id: parentRun.id } as AgentRun;
    await db.prepare('update agent_runs set agent_id=?,parent_run_id=? where id=?').bind('deep_research', parentRun.id, id).run();
    await attachTask(db, childRun, agentDefinition('deep_research'));
    const wait = vi.fn(async () => { await stopTask(db, id, 'completed', '', 'partial'); throw new Error('WorkflowTimeoutError: timed out'); });
    const result = (await executeChildTask({ env: { DB: db, AGENT_WORKFLOW:{create:async()=>({id:'wf'})} } as unknown as RuntimeAgentEnv, step: { ...step, waitForEvent: wait } as unknown as RuntimeWorkflowStep, task, operation, agentId: 'deep_research', summary: {} })).task;
    expect(result.status).toBe('completed'); expect(wait).toHaveBeenCalledOnce();
  });
});

it('preserves an unknown child effect and its saved work without creating another Run', async () => {
  const { db, run } = taskTestDb(); const parentRun = run();
  const task = await attachTask(db, parentRun, agentDefinition('strategy_research'));
  const operation = await beginTaskDecision(db, task, {});
  const childRun = { ...run('exhausted', 'exhausted'), agent_id: 'deep_research', parent_run_id: parentRun.id } as AgentRun;
  await db.prepare('update agent_runs set parent_run_id=?,agent_id=? where id=?').bind(parentRun.id, 'deep_research', childRun.id).run();
  const child = await attachTask(db, childRun, agentDefinition('deep_research'));
  await stopTask(db, childRun.id, 'paused', 'Task budget exhausted', 'budget_exhausted');
  await db.prepare("update agent_tasks set model_calls=max_model_calls,workspace_json=? where id=?").bind('{"report":"Preserved"}', child.id).run();
  await db.prepare("insert into agent_task_operations(id,task_id,turn,status,context_json,created_at,updated_at) values('unknown',?,1,'unknown','{}','now','now')").bind(child.id).run();
  const result = (await executeChildTask({ env: { DB: db } as RuntimeAgentEnv, step, task, operation, agentId: 'deep_research', summary: {}, resumeTaskId: child.id })).task;
  expect(result.id).toBe(child.id); expect(result.workspace_json).toContain('Preserved');
  expect(startRuntimeRun).not.toHaveBeenCalled();
});
it('preserves a stored failed child Run cause instead of reporting a missing task identity', async () => {
  const { db, run } = taskTestDb(); const parentRun = run();
  const task = await attachTask(db, parentRun, agentDefinition('strategy_research'));
  const operation = await beginTaskDecision(db, task, {});
  const child = run(`child-${task.id}-${operation.turn}`, 'failed-child');
  await db.prepare("update agent_runs set parent_run_id=?,agent_id='deep_research',status='failed',error='Original dispatch failure' where id=?").bind(parentRun.id, child.id).run();
  await expect(executeChildTask({ env: { DB: db } as RuntimeAgentEnv, step, task, operation, agentId: 'deep_research', summary: {} })).rejects.toThrow('Original dispatch failure');
  expect(startRuntimeRun).not.toHaveBeenCalled();
});

it('waits for a recovering child without redispatching its failed predecessor', async () => {
  const {db,run} = taskTestDb(); const parent = run(); const task = await attachTask(db,parent,agentDefinition('strategy_research'));
  const operation = await beginTaskDecision(db,task,{}); const id = `child-${task.id}-${operation.turn}`;
  const child = {...run(id,id),agent_id:'deep_research',parent_run_id:parent.id} as AgentRun;
  await db.prepare('update agent_runs set agent_id=?,parent_run_id=? where id=?').bind('deep_research',parent.id,id).run();
  await attachTask(db,child,agentDefinition('deep_research'));
  await db.prepare("update agent_tasks set outcome='execution_recovering' where id=?").bind(id).run();
  const wait = vi.fn(async () => { await db.prepare("update agent_tasks set status='completed',outcome='partial' where id=?").bind(id).run(); return {payload:{}}; });
  const result = (await executeChildTask({env:{DB:db} as RuntimeAgentEnv,step:{...step,waitForEvent:wait} as unknown as RuntimeWorkflowStep,task,operation,agentId:'deep_research',summary:{}})).task;
  expect(result.status).toBe('completed'); expect(dispatchRuntimeWorkflow).not.toHaveBeenCalled(); expect(wait).toHaveBeenCalledOnce();
});
