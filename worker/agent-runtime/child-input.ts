import type { RuntimeAgentEnv } from './env';
import { bindOperation, resolveSlot, saveSlot } from './parameter-slots';
import { createRuntimeExecution, currentExecution, dispatchExecution, type RuntimeExecution } from './runtime-executions';
import { requireTask, taskForRun, taskResumeBlocker, TaskStateError, type AgentTask, type TaskOperation } from './task-store';
import { ToolContractError } from './tool-failure';

type ChildInputObservation = {
  taskId: string; runId: string; execution: RuntimeExecution; revision: number; updatedAt: string;
};
function conflict(message: string): never {
  throw new ToolContractError(message, { kind: 'state_conflict', effects: 'none', issues: [],
    guidance: 'Read the original child task again. Keep existing work and user requests; select a current observed reference.' });
}

/** An observation is not authority. It cannot be rebound to a newer wait on replay. */
export async function observeChildInput(env: RuntimeAgentEnv, parent: AgentTask, child: AgentTask) {
  if (child.parent_task_id !== parent.id || child.workspace_id !== parent.workspace_id || child.site_id !== parent.site_id) return null;
  if (child.status !== 'waiting') return null;
  const execution = await currentExecution(env.DB, child.active_run_id);
  if (!execution || execution.id !== child.execution_id) return null;
  return saveSlot(env.DB, parent, 'child_task_input', { taskId: child.id, runId: child.active_run_id,
    execution, revision: child.revision, updatedAt: child.updated_at } satisfies ChildInputObservation);
}

/** The parent supplies evidence; the child's original loop decides its sufficiency.
 * Parent authority is retained for every write and only direct children are selectable. */
export async function provideChildFacts(env: RuntimeAgentEnv, parent: AgentTask, operation: TaskOperation,
  args: { input_ref: string; facts: string; sources: string[] }) {
  await requireTask(env.DB, parent.active_run_id);
  const bound = await bindOperation(env.DB, parent, operation, args, async () => {
    const observed = await resolveSlot<ChildInputObservation>(env.DB, parent, args.input_ref, 'child_task_input');
    const child = await taskForRun(env.DB, observed.runId);
    if (!child || child.id !== observed.taskId || child.parent_task_id !== parent.id
      || child.workspace_id !== parent.workspace_id || child.site_id !== parent.site_id) conflict('The observed task is not a direct child in this scope');
    const content = JSON.stringify({ type: 'parent_facts', parent_task_id: parent.id, parent_agent_id: parent.agent_id,
      facts: args.facts, reported_sources: args.sources,
      meaning: 'Information from the parent Agent, not a human response or approval. Evaluate the evidence in the original task. Continue, investigate, or keep waiting as appropriate. Existing human requests have not been answered by this message.' });
    if (!args.facts.trim() || content.length > 20000) conflict('Supplementary task information must contain facts and fit within 20000 characters');
    return { observed, id: `parent-input:${operation.id}`, content };
  });
  const { observed } = bound;
  const child = await taskForRun(env.DB, observed.runId);
  if (!child || child.id !== observed.taskId || child.parent_task_id !== parent.id
    || child.workspace_id !== parent.workspace_id || child.site_id !== parent.site_id) conflict('Child relationship changed');
  const saved = await env.DB.prepare('select task_id,content from agent_task_inputs where id=?').bind(bound.id)
    .first<{ task_id: string; content: string }>();
  let execution: RuntimeExecution;
  if (saved) {
    if (saved.task_id !== child.id || saved.content !== bound.content) conflict('Saved input identity does not match this operation');
    const committed = await env.DB.prepare('select * from agent_runtime_executions where task_id=? and epoch=?')
      .bind(child.id, observed.execution.epoch + 1).first<RuntimeExecution>();
    if (!committed) throw new Error('Saved child input has no committed continuation');
    execution = committed;
  } else {
    if (env.AGENT_RUNTIME_ENABLED !== 'true') conflict('Agent Runtime is disabled');
    if (child.status !== 'waiting' || child.execution_id !== observed.execution.id || child.revision !== observed.revision
      || child.updated_at !== observed.updatedAt) conflict('Child task changed after observation');
    const block = await taskResumeBlocker(env.DB, child);
    if (block) conflict(block.message);
    try {
      execution = await createRuntimeExecution(env.DB, child.active_run_id, observed.execution, 'parent_facts', {
        id: bound.id, actorId: parent.id, content: bound.content, revision: observed.revision, updatedAt: observed.updatedAt,
      });
    } catch (error) {
      if (error instanceof TaskStateError && !await env.DB.prepare('select 1 from agent_task_inputs where id=?').bind(bound.id).first()) {
        await requireTask(env.DB, parent.active_run_id);
        conflict('Child task changed or a human response is already being processed');
      }
      throw error;
    }
  }
  // Dispatch reconciles its deterministic Workflow identity. Replaying after the
  // child has moved on never starts the child's newer execution or wait.
  await dispatchExecution(env, execution);
  const current = (await taskForRun(env.DB, child.active_run_id))!;
  return { task_ref: child.id, run_ref: child.active_run_id, input_saved: true, input_id: bound.id,
    execution_ref: execution.id, status: current.status, receipt_kind: 'task_information_supplied',
    meaning: 'Information was saved and continuation requested. This is not a human answer, business approval, completed work, or proof that the child has used the information.' };
}
