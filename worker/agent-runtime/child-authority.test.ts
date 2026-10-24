import { describe, expect, it, vi } from 'vitest';
vi.mock('agents', () => ({ getAgentByName: vi.fn() }));
import { taskTestDb } from './task-test-db';
import { attachTask, beginTaskDecision, requireTask, taskForRun } from './task-store';
import { agentDefinition } from './definitions';
import { executionEnvironment } from './execution-context';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution, currentExecution, dispatchExecution } from './runtime-executions';
import { startRuntimeRun, type StartRuntimeRunInput } from './run-service';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { executeChildTask } from './task-children';

async function fixture() {
  const f = taskTestDb();
  f.sqlite.exec("alter table sites add column workspace_id text default 'w'");
  const parent = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const execution = await createRuntimeExecution(f.db, parent.active_run_id);
  await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  const create = vi.fn(async (options: { id: string; params: unknown }) => ({ id: options.id }));
  const host = { DB: f.db, AGENT_WORKFLOW: { create } } as unknown as RuntimeAgentEnv;
  const env = executionEnvironment(host, authorityForExecution(execution));
  const request: StartRuntimeRunInput = { runId: 'child', instanceId: 'child', workspaceId: 'w', siteId: 's',
    agentId: 'deep_research', trigger: 'sub_agent', parentRunId: parent.active_run_id,
    summary: { research_question: 'Compare public evidence', locale: 'en' } };
  return { ...f, parent, execution, host, env, create, request };
}

describe('real child start with captured parent authority', () => {
  it.each(['deep_research', 'business_research'] as const)('dispatches %s with its own identity and replays one child', async agentId => {
    const f = await fixture();
    const request = { ...f.request, agentId };
    const child = await startRuntimeRun(f.env, request);
    const execution = (await currentExecution(f.db, child.id))!;
    expect(execution.task_id).toBe(child.id);
    expect(f.create.mock.calls[0][0].params).toMatchObject({ execution: authorityForExecution(execution) });
    await expect(requireTask(f.env.DB, child.id)).rejects.toThrow('stale');
    await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
    const childEnv = executionEnvironment(f.host, authorityForExecution(execution));
    await expect(requireTask(childEnv.DB, child.id)).resolves.toMatchObject({ id: child.id });
    await startRuntimeRun(f.env, request);
    expect(await f.db.prepare('select count(*) as n from agent_tasks').first('n')).toBe(2);
    expect(await f.db.prepare('select count(*) as n from agent_runtime_executions').first('n')).toBe(2);
    expect(new Set(f.create.mock.calls.map(call => call[0].id)).size).toBe(1);
    await f.db.prepare("update agent_tasks set status='waiting' where id=?").bind(f.parent.id).run();
    await expect(requireTask(childEnv.DB, child.id)).resolves.toMatchObject({ id: child.id });
    await f.db.prepare("update agent_tasks set status='cancelled' where id=?").bind(f.parent.id).run();
    await expect(childEnv.DB.prepare("update agent_tasks set reason='late' where id=?").bind(child.id).run()).rejects.toThrow('ancestor closed');
  });

  it('inherits subjects through grandchildren without sharing execution authority and rejects changed replay attribution', async () => {
    const f = await fixture();
    const subject = { type: 'document', id: 'document-a', version: 'draft-1' };
    const request = { ...f.request, agentId: 'growth_leader' as const, initialAssignment: { id: 'assignment-a', material: { brief: 'Read document A' }, subjects: [subject] } };
    await startRuntimeRun(f.env, request);
    const childExecution = (await currentExecution(f.db, 'child'))!;
    await activateRuntimeExecution(f.db, authorityForExecution(childExecution), childExecution.workflow_id);
    const childEnv = executionEnvironment(f.host, authorityForExecution(childExecution));
    await startRuntimeRun(childEnv, { ...f.request, runId: 'grandchild', instanceId: 'grandchild', agentId: 'growth_leader', parentRunId: 'child' });
    const grandExecution = (await currentExecution(f.db, 'grandchild'))!;
    await activateRuntimeExecution(f.db, authorityForExecution(grandExecution), grandExecution.workflow_id);
    const grandEnv = executionEnvironment(f.host, authorityForExecution(grandExecution));
    await startRuntimeRun(grandEnv, { ...f.request, runId: 'great-grandchild', instanceId: 'great-grandchild', parentRunId: 'grandchild' });
    for (const id of ['child', 'grandchild', 'great-grandchild']) {
      const row = await f.db.prepare('select subjects_json,parent_task_id,parent_assignment_id from agent_tasks where id=?').bind(id).first<{ subjects_json: string; parent_task_id: string; parent_assignment_id: string }>();
      expect(JSON.parse(row!.subjects_json)).toEqual([subject]);
      if (id === 'grandchild') expect(row).toMatchObject({ parent_task_id: 'child', parent_assignment_id: 'assignment-a' });
    }
    await startRuntimeRun(f.env, request);
    await expect(startRuntimeRun(f.env, { ...request, initialAssignment: { ...request.initialAssignment, subjects: [{ ...subject, id: 'document-b' }] } })).rejects.toThrow('subject identity conflict');
    await expect(startRuntimeRun(f.env, { ...request, initialAssignment: { ...request.initialAssignment, id: 'different-assignment' } })).rejects.toThrow('subject identity conflict');
    expect(await f.db.prepare('select count(*) as n from agent_tasks').first('n')).toBe(4);
    await expect(requireTask(grandEnv.DB, 'great-grandchild')).rejects.toThrow('stale');
  });

  it('recovers attachment completed before Execution creation without replacing credentials', async () => {
    const f = await fixture();
    // Interrupt exactly after the attachment transaction commits.
    const interrupted = new Proxy(f.env.DB, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
        const result = await target.batch(statements);
        const child = await taskForRun(f.db, 'child');
        if (child && !child.execution_id) throw new Error('host interrupted');
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    // Use attachment directly to emulate process death without service cleanup.
    const childRun = { ...f.run('child', 'child'), parent_run_id: f.parent.active_run_id };
    await expect(attachTask(interrupted, childRun, agentDefinition('strategy_research'))).rejects.toThrow('interrupted');
    const receipt = await attachTask(f.env.DB, childRun, agentDefinition('strategy_research'));
    expect(receipt.id).toBe('child');
    const execution = await createRuntimeExecution(f.env.DB, receipt.active_run_id);
    await dispatchExecution(f.env, execution);
    expect(execution.epoch).toBe(1);
    expect(f.create).toHaveBeenCalledOnce();
  });

  it('rejects an old parent before any new child is persisted or dispatched', async () => {
    const f = await fixture();
    await createRuntimeExecution(f.db, f.parent.active_run_id, f.execution, 'handoff');
    await expect(startRuntimeRun(f.env, f.request)).rejects.toThrow('stale');
    expect(await taskForRun(f.db, 'child')).toBeNull();
    expect(f.create).not.toHaveBeenCalled();
  });

  it('rejects unrelated parents, root creation and cross-site child requests', async () => {
    const f = await fixture();
    await attachTask(f.db, f.run('other', 'other'), agentDefinition('strategy_research'));
    await expect(startRuntimeRun(f.env, { ...f.request, parentRunId: 'other' })).rejects.toThrow('stale');
    await expect(startRuntimeRun(f.env, { ...f.request, siteId: 'other' })).rejects.toThrow('scope mismatch');
    await expect(startRuntimeRun(f.env, { ...f.request, trigger: 'manual', parentRunId: undefined })).rejects.toThrow('only start child');
    await expect(createRuntimeExecution(f.env.DB, 'other')).rejects.toThrow('direct parent');
    expect(f.create).not.toHaveBeenCalled();
  });

  it('checks cancellation again before dispatching a persisted child', async () => {
    const f = await fixture();
    await startRuntimeRun(f.env, f.request);
    const execution = (await currentExecution(f.db, 'child'))!;
    f.create.mockClear();
    await f.db.prepare("update agent_tasks set status='cancelled' where id=?").bind(f.parent.id).run();
    await expect(dispatchExecution(f.env, execution)).rejects.toThrow('no longer writable');
    expect(f.create).not.toHaveBeenCalled();
  });

  it('runs the parent tool through the real service and returns the same saved child result on replay', async () => {
    const f = await fixture();
    const task = await requireTask(f.env.DB, f.parent.active_run_id);
    const operation = await beginTaskDecision(f.env.DB, task, {});
    const step = {
      do: async (_key: string, config: unknown, fn?: () => Promise<unknown>) => (fn || config as () => Promise<unknown>)(),
      waitForEvent: async () => {
        await f.db.prepare("update agent_tasks set status='completed',output_json=? where parent_task_id=?")
          .bind(JSON.stringify({ outcome: 'partial', summary: 'Evidence collected' }), task.id).run();
      },
    } as unknown as RuntimeWorkflowStep;
    const input = { env: f.env, step, task, operation, agentId: 'deep_research' as const, summary: f.request.summary };
    const first = (await executeChildTask(input)).task;
    const replay = (await executeChildTask(input)).task;
    expect(first.status).toBe('completed');
    expect(replay.id).toBe(first.id);
    expect(JSON.parse(replay.output_json)).toMatchObject({ summary: 'Evidence collected' });
    expect(f.create).toHaveBeenCalledOnce();
  });

  it('reconciles a lost Workflow create response using the same child dispatch identity', async () => {
    const f = await fixture();
    f.create.mockRejectedValueOnce(new Error('response lost'));
    const get = vi.fn(async (id: string) => ({ id, status: async () => ({ status: 'running' }) }));
    const env = { ...f.env, AGENT_WORKFLOW: { create: f.create, get } } as unknown as RuntimeAgentEnv;
    const child = await startRuntimeRun(env, f.request);
    const execution = (await currentExecution(f.db, child.id))!;
    expect(get).toHaveBeenCalledWith(execution.workflow_id);
    expect(f.create).toHaveBeenCalledOnce();
    expect((await taskForRun(f.db, child.id))?.status).toBe('running');
  });
});
