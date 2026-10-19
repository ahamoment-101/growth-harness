import { settleRuntimeCheckpoint } from './runtime-checkpoint';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { executionEnvironment, type RuntimeExecutionContext } from './execution-context';
import { activateRuntimeExecution, currentExecution, ExecutionHandoff, recoverExecution } from './runtime-executions';
import { executionStep } from './execution-step';
import { runtimeAgentModule, type AgentModuleExecutionContext } from './agent-modules';
import { getAgentRun, appendAgentEvent } from './store';
import { accountExecutionBoundary, accountedEnvironment, accountedStep } from './request-accounting';
import { faultAwareStep } from './platform-step';
import { requireTask, taskForRun } from './task-store';
import { startRuntimeRun } from './run-service';
import { executionFailure } from './execution-failure';
import { recordExecutionFailure } from './task-recovery';
import type { AgentId } from './definitions';
import { pokeSite } from '../site-room/poke';

type ExecutionParams = { runId: string; workspaceId: string; siteId: string; agentId: AgentId; instanceId?: string; execution: RuntimeExecutionContext };

/** Workflow completion is an execution receipt. The Task is business authority. */
export async function executeContinuousWorkflow(host: RuntimeAgentEnv, params: ExecutionParams, workflowId: string, workflowStep: RuntimeWorkflowStep) {
  // Live views learn about every checkpoint, handoff or failure this execution wrote.
  try { return await runExecution(host, params, workflowId, workflowStep); }
  finally { await pokeSite(host, params.siteId, { progress: { workspaceId: params.workspaceId, taskId: params.execution.taskId } }); }
}

async function runExecution(host: RuntimeAgentEnv, params: ExecutionParams, workflowId: string, workflowStep: RuntimeWorkflowStep) {
  if (params.execution.runId !== params.runId) throw new Error('Workflow execution identity mismatch');
  const module = runtimeAgentModule(params.agentId);
  const checkpoint = await settleRuntimeCheckpoint(host, params.execution);
  if (checkpoint) return checkpoint;
  await activateRuntimeExecution(host.DB, params.execution, workflowId);
  const env = executionEnvironment(host, params.execution);
  const progress = { workspaceId: params.workspaceId, taskId: params.execution.taskId };
  const step = executionStep(workflowStep, env, () => pokeSite(host, params.siteId, { coalesce: true, progress }));
  const run = await getAgentRun(env.DB, params.runId);
  if (!run || run.workspace_id !== params.workspaceId || run.site_id !== params.siteId || run.agent_id !== params.agentId || run.agent_instance_id !== (params.instanceId || '')) throw new Error('Workflow task scope mismatch');
  await requireTask(env.DB, run.id);
  try {
    await env.DB.prepare("update agent_runs set status='running',phase='running',started_at=case when started_at='' then ? else started_at end,updated_at=? where id=?").bind(new Date().toISOString(), new Date().toISOString(), run.id).run();
    await appendAgentEvent(env.DB, { runId: run.id, eventKey: `execution:${params.execution.epoch}:started`, kind: 'run_started', phase: 'running', actorType: 'workflow', payload: { execution_id: params.execution.executionId, epoch: params.execution.epoch } });
    await accountExecutionBoundary(env, workflowStep, run.id, async () => {
      const scoped = accountedEnvironment(env);
      const context: AgentModuleExecutionContext = { env: scoped, step: faultAwareStep(accountedStep(step, scoped, run.id)), definition: module.definition,
        run, values: {}, snapshotId: '', scenario: '', startChildRun: request => startRuntimeRun(scoped, request),
        waitForApproval: async () => { throw new Error('Business approvals use explicit business APIs'); },
        waitForInput: async () => { throw new Error('Use a persisted task waiting outcome'); } };
      return module.execute(context);
    });
    const checkpoint = await settleRuntimeCheckpoint(host, params.execution);
    if (!checkpoint) throw new Error('Agent executor returned without a Runtime checkpoint');
    return checkpoint;
  } catch (error) {
    const current = await currentExecution(host.DB, run.id);
    const task = await taskForRun(host.DB, run.id);
    if (current?.id !== params.execution.executionId || !task || task.status === 'cancelled') throw error;
    if (error instanceof ExecutionHandoff) {
      await recoverExecution(host, current, 'workflow_capacity');
      return { task_id: task.id, run_id: run.id, execution_id: current.id, outcome: 'execution_handoff' };
    }
    await recordExecutionFailure(env, run.id, executionFailure(error, 'workflow') || {
      origin: 'unknown', scope: 'execution', recovery_action: 'new_execution', message: String(error).slice(0, 2000), status: 0, request_id: '', stage: 'workflow',
    });
    const stopped = await taskForRun(host.DB, run.id);
    return { task_id: task.id, run_id: run.id, outcome: stopped?.status === 'paused' ? 'paused' : 'recovering', reason: String(error) };
  }
}
