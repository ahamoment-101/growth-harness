import { describe, expect, it, vi } from 'vitest';

vi.mock('agents', () => ({ getAgentByName: vi.fn() }));
import { assertRuntimeRunRequest, dispatchRuntimeWorkflow, startRuntimeRun } from './run-service';
import { taskTestDb } from './task-test-db';
import type { RuntimeAgentEnv, RuntimeWorkflowBinding, RuntimeWorkflowInstance } from './env';

function runtimeEnv(workflow: RuntimeWorkflowBinding): RuntimeAgentEnv {
  return {
    AGENT_WORKFLOW: workflow,
  } as RuntimeAgentEnv;
}

function workflowInstance(id: string, status = 'queued') {
  const dispose = vi.fn();
  const disposeSymbol = (Symbol as unknown as { dispose: symbol }).dispose;
  const instance = {
    id,
    status: vi.fn(async () => ({ status })),
    terminate: vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => undefined),
    [disposeSymbol]: dispose,
  } as unknown as RuntimeWorkflowInstance;
  return { instance, dispose };
}

describe('runtime Run creation policy', () => {
  const base = { workspaceId: 'workspace-1', siteId: 'site-1', agentId: 'strategy_research' as const };

  it('accepts only explicit, internally consistent trigger lineage', () => {
    expect(() => assertRuntimeRunRequest({ ...base, trigger: 'manual' })).not.toThrow();
    expect(() => assertRuntimeRunRequest({ ...base, trigger: 'retry', retryOfRunId: 'old-run' })).not.toThrow();
    expect(() => assertRuntimeRunRequest({ ...base, trigger: 'retry', retryOfRunId: 'old-run', parentRunId: 'current-parent' })).not.toThrow();
    expect(() => assertRuntimeRunRequest({ ...base, trigger: 'sub_agent', parentRunId: 'parent-run' })).not.toThrow();
    expect(() => assertRuntimeRunRequest({ ...base, trigger: 'retry' })).toThrow('retryOfRunId');
    expect(() => assertRuntimeRunRequest({ ...base, trigger: 'manual', retryOfRunId: 'forged' })).toThrow('only valid');
    expect(() => assertRuntimeRunRequest({ ...base, trigger: 'manual', parentRunId: 'forged' })).toThrow('only valid');
    expect(() => assertRuntimeRunRequest({ ...base, trigger: 'cron' })).toThrow('scheduleKey');
    expect(() => assertRuntimeRunRequest({ ...base, trigger: 'cron', scheduleKey: '2026-08-24T08:00' })).not.toThrow();
    expect(() => assertRuntimeRunRequest({ ...base, agentId: 'content_review', trigger: 'manual' })).toThrow('content parent Agent');
    expect(() => assertRuntimeRunRequest({
      ...base, agentId: 'content_review', instanceId: 'artifact-1', trigger: 'retry', retryOfRunId: 'old-review',
    })).toThrow('current content parent Run');
    expect(() => assertRuntimeRunRequest({
      ...base, agentId: 'content_review', instanceId: 'artifact-1', trigger: 'sub_agent', parentRunId: 'parent-run',
    })).not.toThrow();
  });

  it('rejects a scheduled strategy start before creating a Run or dispatching work', async () => {
    const f = taskTestDb();
    f.sqlite.exec("alter table sites add column workspace_id text default 'w'");
    const create = vi.fn();
    await expect(startRuntimeRun({ DB: f.db, AGENT_WORKFLOW: { create } } as unknown as RuntimeAgentEnv, {
      workspaceId: 'w', siteId: 's', agentId: 'strategy_research', trigger: 'cron', scheduleKey: 'strategy:en:2026-09-14',
      instanceId: 'strategy:en', summary: { locale: 'en' },
    })).rejects.toThrow('does not allow scheduled Runs');
    expect(create).not.toHaveBeenCalled();
    expect(await f.db.prepare('select count(*) as n from agent_runs').first()).toEqual({ n: 0 });
  });

  it('dispatches a Runtime Workflow without routing the launch through a Durable Object', async () => {
    const created = workflowInstance('wf_run-1');
    const create = vi.fn(async (_options?: { id?: string; params?: unknown }) => created.instance);
    const get = vi.fn(async () => { throw new Error('not found'); });

    await expect(dispatchRuntimeWorkflow(runtimeEnv({ create, get }), {
      runId: 'run-1', workspaceId: 'workspace-1', siteId: 'site-1', agentId: 'strategy_research', instanceId: 'strategy:en',
    })).resolves.toBe('wf_run-1');

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      id: 'wf_run-1',
      params: expect.objectContaining({
        runId: 'run-1',
        workspaceId: 'workspace-1',
        siteId: 'site-1',
        agentId: 'strategy_research',
        instanceId: 'strategy:en',
      }),
    }));
    const createdParams = create.mock.calls[0]?.[0]?.params as Record<string, unknown>;
    expect(createdParams).not.toHaveProperty('__agentOrigin');
    expect(created.dispose).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });

  it('recovers an uncertain create response by reading the deterministic Workflow id', async () => {
    const existing = workflowInstance('wf_run-2', 'running');
    const createError = new Error('Connection closed: response was lost');
    const create = vi.fn(async () => { throw createError; });
    const get = vi.fn(async () => existing.instance);

    await expect(dispatchRuntimeWorkflow(runtimeEnv({ create, get }), {
      runId: 'run-2', workspaceId: 'workspace-1', siteId: 'site-1', agentId: 'topic_decision',
    })).resolves.toBe('wf_run-2');

    expect(get).toHaveBeenCalledWith('wf_run-2');
    expect(existing.dispose).toHaveBeenCalledOnce();
  });

  it('preserves a real dispatch failure when deterministic read-back finds no instance', async () => {
    const createError = new Error('Workflow binding unavailable');
    const create = vi.fn(async () => { throw createError; });
    const get = vi.fn(async () => { throw new Error('not found'); });

    await expect(dispatchRuntimeWorkflow(runtimeEnv({ create, get }), {
      runId: 'run-3', workspaceId: 'workspace-1', siteId: 'site-1', agentId: 'strategy_research',
    })).rejects.toBe(createError);
  });
});
