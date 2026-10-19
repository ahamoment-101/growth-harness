import { persistRuntimeJson } from './runtime-content';
import { ToolContractError } from './tool-failure';
import { waitForChildRuns } from './child-run-wait';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { agentDefinition, type AgentId } from './definitions';
import { getAgentRun } from './store';
import { startRuntimeRun } from './run-service';
import { attachTask, taskResumeBlock, taskResumeBlocker, requireTask, taskForRun, type AgentTask, type TaskOperation, type TaskResumeBlock } from './task-store';
import { bindOperation } from './parameter-slots';
import { currentExecution, createRuntimeExecution, dispatchExecution } from './runtime-executions';

/** What happened to a parent's resume request, separate from the child's own status. */
export type ChildResumeReceipt = { requested: boolean; performed: boolean; block: TaskResumeBlock | null };

/** The parent persists a child identity and any exact resume predecessor before dispatch. */
export async function dispatchChildTask(input: {
  env: RuntimeAgentEnv; step: RuntimeWorkflowStep; task: AgentTask; operation: TaskOperation;
  agentId: AgentId; summary: unknown; resumeTaskId?: string; instanceId?: string; assignment?: unknown;
}): Promise<{ task: AgentTask; resume: ChildResumeReceipt; wait: boolean }> {
  const { env, task, operation } = input;
  await requireTask(env.DB, task.active_run_id);
  const binding = await bindOperation(env.DB, task, operation, { agent_id: input.agentId, resume_task_id: input.resumeTaskId || '', summary: input.summary, ...(input.assignment ? { assignment: input.assignment } : {}), ...(input.instanceId ? { instanceId: input.instanceId } : {}) }, async () => {
    if (!input.resumeTaskId) return { runId: `child-${task.id}-${operation.turn}`, predecessor: null, blocked: false };
    const child = await env.DB.prepare('select * from agent_tasks where id=? and parent_task_id=? and workspace_id=? and site_id=?')
      .bind(input.resumeTaskId, task.id, task.workspace_id, task.site_id).first<AgentTask>();
    if (!child || child.agent_id !== input.agentId || !['paused','waiting','failed'].includes(child.status)) throw new ToolContractError('Child task cannot resume in this scope or state', { kind: 'state_conflict', issues: [], effects: 'none', guidance: 'Use an observed child task reference.' });
    return { runId: child.active_run_id, predecessor: await currentExecution(env.DB, child.active_run_id), blocked: Boolean(await taskResumeBlock(env.DB, child)) };
  });
  if (!binding.blocked) {
    if (binding.predecessor) {
      const current = await currentExecution(env.DB, binding.runId);
      // A completed recovery is never restarted when the parent replays its tool.
      if (current?.id === binding.predecessor.id) {
        const next = await createRuntimeExecution(env.DB, binding.runId, binding.predecessor, 'parent_resume');
        await dispatchExecution(env, next);
      } else if (current) await dispatchExecution(env, current);
    } else {
      let saved = await taskForRun(env.DB, binding.runId);
      if (saved && (saved.parent_task_id !== task.id || saved.agent_id !== input.agentId)) throw new Error('Child task ownership mismatch');
      if (saved && !input.resumeTaskId && saved.status !== 'running') return { task: saved, wait: false, resume: { requested: false, performed: false, block: saved.status === 'completed' ? null : await taskResumeBlocker(env.DB, saved) } };
      const persisted = saved ? null : await getAgentRun(env.DB, binding.runId);
      if (persisted) {
        if (persisted.parent_run_id !== task.active_run_id || persisted.agent_id !== input.agentId) throw new Error('Child Run ownership mismatch');
        if (['failed','cancelled'].includes(persisted.status)) throw new ToolContractError(persisted.error || 'Original child dispatch failed', { kind:'state_conflict',effects:'none',issues:[],guidance:'Inspect the original child dispatch receipt.' });
        saved = await attachTask(env.DB,persisted,agentDefinition(input.agentId));
      }
      if (saved) {
        if (input.assignment) {
          await env.DB.batch([
            env.DB.prepare('insert or ignore into agent_task_assignments(id,task_id,operation_id,context_json,created_at) values(?,?,?,?,?)')
              .bind(`${binding.runId}:leader`, saved.id, `${binding.runId}:leader`, await persistRuntimeJson(env.DB, input.assignment), new Date().toISOString()),
            env.DB.prepare("update agent_tasks set assignment_id=? where id=? and assignment_id=''").bind(`${binding.runId}:leader`, saved.id),
          ]);
        }
        if (saved.outcome !== 'execution_recovering') {
          const execution = await currentExecution(env.DB,binding.runId) || await createRuntimeExecution(env.DB,binding.runId);
          await dispatchExecution(env,execution);
        }
      } else await startRuntimeRun(env, { runId: binding.runId, workspaceId: task.workspace_id, siteId: task.site_id,
        agentId: input.agentId, instanceId: input.instanceId || binding.runId, trigger: 'sub_agent', parentRunId: task.active_run_id, summary: input.summary, ...(input.assignment ? { initialAssignment: { id: `${binding.runId}:leader`, material: input.assignment } } : {}) });
    }
  }
  const result = await taskForRun(env.DB, binding.runId);
  if (!result || result.parent_task_id !== task.id || result.agent_id !== input.agentId) throw new Error('Child task identity mismatch');
  const requested = Boolean(input.resumeTaskId);
  return { task: result, wait: !binding.blocked, resume: { requested, performed: requested && !binding.blocked,
    block: result.status === 'completed' ? null : await taskResumeBlocker(env.DB, result) } };
}

/** Existing callers retain dispatch-and-wait semantics. */
export async function executeChildTask(input: Parameters<typeof dispatchChildTask>[0]) {
  const dispatched = await dispatchChildTask(input);
  if (dispatched.wait) await waitForChildRuns({ env: input.env, step: input.step, stepKey: `child:${input.operation.id}`, runIds: [dispatched.task.active_run_id] });
  const task = (await taskForRun(input.env.DB, dispatched.task.active_run_id))!;
  return { task, resume: { ...dispatched.resume, block: task.status === 'completed' ? null : await taskResumeBlocker(input.env.DB, task) } };
}
