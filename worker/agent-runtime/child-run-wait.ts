import { deliverLeaderReport } from '../growth-leader/service';
import { taskForRun } from './task-store';
import { runtimeJsonText } from './runtime-content';
/**
 * How a parent Run durably waits for its child Runs.
 *
 * A child reports completion by sending an event to its parent's Workflow, so
 * the parent is woken as soon as the child is done instead of discovering it on
 * the next poll tick. Event delivery is best effort — D1 stays authoritative —
 * so every wake-up, and every wait that expires without an event, is followed by
 * a fresh read of the child Runs. That read is what decides; the event only
 * decides when to look.
 *
 * The consequence that matters: how long a parent may wait is no longer encoded
 * in a poll count. A child that legitimately takes hours is waited for, and a
 * child that dies without reporting is still noticed within one reconciliation
 * interval.
 */
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { agentDefinition, isAgentId } from './definitions';
import { disposeRpcResource } from './rpc-resource';
import { getAgentRun } from './store';
import { READINESS_CHECK_STEP } from './runtime-limits';

export const CHILD_FINISHED_EVENT = 'child_run_finished';

/**
 * Because the parent is woken by an event, this is only the reconciliation
 * cadence for a child that dies without reporting. Execution handoffs keep
 * the host's step count bounded while the parent retains its original Run.
 */
const CHILD_EVENT_WAIT_TIMEOUT = '5 minutes';


export type ChildRunStatus = {
  runId: string;
  status: string;
  phase: string;
  outputJson: string;
  error: string;
};

const TERMINAL_CHILD_STATUSES = ['succeeded', 'failed', 'cancelled', 'missing'];

function isTerminalChildStatus(status: string): boolean {
  return TERMINAL_CHILD_STATUSES.includes(status);
}

/**
 * A wait that expires is the reconciliation path, not a failure: the parent
 * re-reads D1 and decides from there. Anything else is a real error and must
 * not be swallowed.
 */
function isWaitExpiry(error: unknown): boolean {
  const name = error && typeof error === 'object' ? String((error as { name?: unknown }).name || '') : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'WorkflowTimeoutError' || /timed? ?out/i.test(message);
}

export async function waitForChildRuns(input: {
  env: RuntimeAgentEnv;
  step: RuntimeWorkflowStep;
  stepKey: string;
  runIds: readonly string[];
  assignments?: Record<string, string>;
}): Promise<ChildRunStatus[]> {
  const readStatuses = (round: number) => input.step.do(
    `${input.stepKey}-status-${round}`,
    READINESS_CHECK_STEP,
    async () => Promise.all(input.runIds.map(async (runId) => {
      const run = await getAgentRun(input.env.DB, runId);
      const task = await input.env.DB.prepare('select id,assignment_id,status,output_json from agent_tasks where active_run_id=?').bind(runId).first<{id:string;assignment_id:string;status:string;output_json:string}>();
      const assignment = input.assignments?.[runId] || task?.assignment_id || `${task?.id}:initial`;
      const checkpoint = task ? await input.env.DB.prepare('select output_json from agent_task_checkpoints where task_id=? and assignment_id=? order by created_at desc limit 1').bind(task.id, assignment).first<{output_json:string}>() : null;
      return {
        runId,
        status: checkpoint ? 'succeeded' : task?.status === 'completed' ? 'succeeded' : run?.status || 'missing',
        phase: run?.phase || '',
        outputJson: checkpoint?.output_json || task?.output_json || run?.output_json || '{}',
        error: run?.error || '',
      } satisfies ChildRunStatus;
    })),
  );

  let statuses = await readStatuses(0);
  for (let round = 1; true; round += 1) {
    if (statuses.every((item) => isTerminalChildStatus(item.status))) return Promise.all(statuses.map(async item => ({ ...item, outputJson: await runtimeJsonText(input.env.DB, item.outputJson) })));
    try {
      await input.step.waitForEvent(`${input.stepKey}-event-${round}`, {
        type: CHILD_FINISHED_EVENT,
        timeout: CHILD_EVENT_WAIT_TIMEOUT,
      });
    } catch (error) {
      if (!isWaitExpiry(error)) throw error;
    }
    // One event does not identify which child finished, and a buffered event
    // from an earlier batch can wake this wait early. The re-read is what
    // establishes the truth in both cases.
    statuses = await readStatuses(round);
  }
}


/**
 * The reporting half of the same protocol: a child tells its parent's Workflow
 * that it reached a terminal state, so the parent stops waiting immediately
 * instead of at the next reconciliation.
 *
 * Delivery is best effort by design. D1 already holds the truth, and the parent
 * re-reads it on every wake-up, so a lost event costs one reconciliation
 * interval rather than correctness — which is why this degrades to a warning
 * instead of failing an otherwise complete Run.
 */
export async function notifyParentRunFinished(env: RuntimeAgentEnv, runId: string): Promise<void> {
  await deliverLeaderReport(env, runId);
  const run = await getAgentRun(env.DB, runId);
  if (!run?.parent_run_id) return;
  const childTask = await taskForRun(env.DB, runId);
  if (childTask?.status === 'running') return;
  const parentTask = isAgentId(run.agent_id) && agentDefinition(run.agent_id).taskBased ? await taskForRun(env.DB, run.parent_run_id) : null;
  const parent = await getAgentRun(env.DB, parentTask?.active_run_id || run.parent_run_id);
  if (!parent?.workflow_id || !isAgentId(parent.agent_id)) return;
  try {
    const binding = env[agentDefinition(parent.agent_id).workflowBinding];
    const instance = await binding.get(parent.workflow_id);
    try {
      await instance.sendEvent({
        type: CHILD_FINISHED_EVENT,
        payload: { runId: run.id, parentRunId: parent.id, agentId: run.agent_id, status: run.status },
      });
    } finally {
      disposeRpcResource(instance);
    }
  } catch (error) {
    console.warn(
      `[agent-runtime] Child completion event degraded; the parent reconciles from D1: ${String(error).slice(0, 300)}`,
    );
  }
}
