import { describe, expect, it, vi } from 'vitest';
import {
  CHILD_FINISHED_EVENT,
  notifyParentRunFinished,
  waitForChildRuns,
} from './child-run-wait';

type RunRow = {
  id: string; status: string; phase: string; output_json: string; error: string;
  agent_id?: string; parent_run_id?: string; workflow_id?: string;
};

/** D1 stays authoritative, so the fake database is the only source of truth the
 * parent is allowed to decide from. */
function runsDb(rows: Map<string, RunRow>) {
  return {
    prepare: (sql: string) => ({
      bind: (runId: string) => ({ first: async () => sql.includes('from agent_runs') ? rows.get(runId) ?? null : null }),
    }),
  } as never;
}

function childRow(id: string, status: string, extra: Partial<RunRow> = {}): RunRow {
  return { id, status, phase: '', output_json: '{}', error: '', ...extra };
}

type WaitCall = { name: string; type: string };

function recordingStep(input: {
  waits: WaitCall[];
  reads: string[];
  onWait?: (round: number) => void | Promise<void>;
}) {
  const expired = () => {
    const error = new Error('Execution timed out after 300000ms');
    error.name = 'WorkflowTimeoutError';
    return error;
  };
  return {
    step: {
      do: async (name: string, configOrExecute: unknown, maybeExecute?: () => Promise<unknown>) => {
        input.reads.push(name);
        return (maybeExecute || configOrExecute as () => Promise<unknown>)();
      },
      sleep: async () => undefined,
      waitForEvent: async (name: string, options: { type: string }) => {
        input.waits.push({ name, type: options.type });
        await input.onWait?.(input.waits.length);
        throw expired();
      },
    } as never,
    expired,
  };
}

describe('durable parent waiting for child Runs', () => {
  it('does not wait at all when every child has already finished', async () => {
    const waits: WaitCall[] = [];
    const reads: string[] = [];
    const rows = new Map([
      ['child-a', childRow('child-a', 'succeeded')],
      ['child-b', childRow('child-b', 'failed', { error: 'model route failed' })],
    ]);
    const { step } = recordingStep({ waits, reads });

    const statuses = await waitForChildRuns({
      env: { DB: runsDb(rows) } as never, step, stepKey: 'group-1', runIds: ['child-a', 'child-b'],
    });

    expect(waits).toEqual([]);
    expect(reads).toEqual(['group-1-status-0']);
    expect(statuses).toEqual([
      { runId: 'child-a', status: 'succeeded', phase: '', outputJson: '{}', error: '' },
      { runId: 'child-b', status: 'failed', phase: '', outputJson: '{}', error: 'model route failed' },
    ]);
  });

  it('reconciles from D1 when a child finishes without reporting', async () => {
    const waits: WaitCall[] = [];
    const reads: string[] = [];
    const rows = new Map([['child-a', childRow('child-a', 'running')]]);
    // The event never arrives; only the expiry brings the parent back to look.
    const { step } = recordingStep({
      waits, reads,
      onWait: () => { rows.set('child-a', childRow('child-a', 'succeeded', { phase: 'completed' })); },
    });

    const statuses = await waitForChildRuns({
      env: { DB: runsDb(rows) } as never, step, stepKey: 'group-2', runIds: ['child-a'],
    });

    expect(waits).toEqual([{ name: 'group-2-event-1', type: CHILD_FINISHED_EVENT }]);
    expect(statuses).toEqual([
      { runId: 'child-a', status: 'succeeded', phase: 'completed', outputJson: '{}', error: '' },
    ]);
  });

  it('keeps waiting when a wake-up does not mean this child is done', async () => {
    const waits: WaitCall[] = [];
    const reads: string[] = [];
    const rows = new Map([['child-a', childRow('child-a', 'running')]]);
    // A buffered event from an earlier batch can wake the wait early; only the
    // re-read decides, so the parent goes back to waiting.
    const { step } = recordingStep({
      waits, reads,
      onWait: (round) => {
        if (round === 3) rows.set('child-a', childRow('child-a', 'cancelled'));
      },
    });

    const statuses = await waitForChildRuns({
      env: { DB: runsDb(rows) } as never, step, stepKey: 'group-3', runIds: ['child-a'],
    });

    expect(waits.map((wait) => wait.name)).toEqual([
      'group-3-event-1', 'group-3-event-2', 'group-3-event-3',
    ]);
    expect(statuses[0].status).toBe('cancelled');
  });

  it('treats a child Run that vanished as terminal instead of waiting for it', async () => {
    const waits: WaitCall[] = [];
    const reads: string[] = [];
    const { step } = recordingStep({ waits, reads });

    const statuses = await waitForChildRuns({
      env: { DB: runsDb(new Map()) } as never, step, stepKey: 'group-4', runIds: ['missing-child'],
    });

    expect(waits).toEqual([]);
    expect(statuses[0]).toMatchObject({ runId: 'missing-child', status: 'missing' });
  });

  it('keeps waiting beyond the retired reconciliation cap until the child produces a result', async () => {
    const waits: WaitCall[] = [];
    const reads: string[] = [];
    const rows = new Map([['child-a', childRow('child-a', 'running')]]);
    const { step } = recordingStep({ waits, reads, onWait: round => { if (round === 121) rows.set('child-a', childRow('child-a', 'succeeded')); } });

    const statuses = await waitForChildRuns({
      env: { DB: runsDb(rows) } as never, step, stepKey: 'group-5', runIds: ['child-a'],
    });

    expect(waits).toHaveLength(121);
    expect(statuses[0].status).toBe('succeeded');
  });

  it('does not swallow a wait failure that is not an expiry', async () => {
    const rows = new Map([['child-a', childRow('child-a', 'running')]]);
    const step = {
      do: async (_name: string, configOrExecute: unknown, maybeExecute?: () => Promise<unknown>) =>
        (maybeExecute || configOrExecute as () => Promise<unknown>)(),
      sleep: async () => undefined,
      waitForEvent: async () => { throw new Error('Workflow instance was terminated'); },
    } as never;

    await expect(waitForChildRuns({
      env: { DB: runsDb(rows) } as never, step, stepKey: 'group-6', runIds: ['child-a'],
    })).rejects.toThrow('terminated');
  });
});

describe('a child Run reporting to its parent', () => {
  function reportingEnv(rows: Map<string, RunRow>, sendEvent: (event: unknown) => Promise<void>) {
    return {
      DB: runsDb(rows),
      AGENT_WORKFLOW: {
        get: async (id: string) => ({ id, sendEvent }),
      },
    } as never;
  }

  it('wakes the parent Workflow as soon as the child reaches a terminal state', async () => {
    const sendEvent = vi.fn(async () => undefined);
    const rows = new Map<string, RunRow>([
      ['child-a', { ...childRow('child-a', 'succeeded'), agent_id: 'article_production', parent_run_id: 'parent-1' }],
      ['parent-1', { ...childRow('parent-1', 'running'), agent_id: 'content_production', workflow_id: 'wf_parent-1' }],
    ]);

    await notifyParentRunFinished(reportingEnv(rows, sendEvent), 'child-a');

    expect(sendEvent).toHaveBeenCalledWith({
      type: CHILD_FINISHED_EVENT,
      payload: { runId: 'child-a', parentRunId: 'parent-1', agentId: 'article_production', status: 'succeeded' },
    });
  });

  it('stays silent for a Run that has no parent', async () => {
    const sendEvent = vi.fn(async () => undefined);
    const rows = new Map<string, RunRow>([
      ['solo', { ...childRow('solo', 'succeeded'), agent_id: 'topic_decision' }],
    ]);

    await notifyParentRunFinished(reportingEnv(rows, sendEvent), 'solo');

    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('degrades to a warning when the event cannot be delivered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sendEvent = vi.fn(async () => { throw new Error('Durable Object instance is no longer active'); });
    const rows = new Map<string, RunRow>([
      ['child-b', { ...childRow('child-b', 'failed'), agent_id: 'content_review', parent_run_id: 'parent-2' }],
      ['parent-2', { ...childRow('parent-2', 'running'), agent_id: 'content_production', workflow_id: 'wf_parent-2' }],
    ]);

    // D1 already holds the terminal status, so a lost event must not fail the
    // child Run that actually completed.
    await expect(notifyParentRunFinished(reportingEnv(rows, sendEvent), 'child-b')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reconciles from D1'));
    warn.mockRestore();
  });
});
