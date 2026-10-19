import { z } from 'zod';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import type { AgentTask, TaskOperation } from '../agent-runtime/task-store';
import { requireTask, writeTaskWorkspace } from '../agent-runtime/task-store';
import { bindOperation, resolveSlot, saveSlot } from '../agent-runtime/parameter-slots';
import { ToolRegistry } from '../agent-runtime/tools';

export const LEADER_TODO_INSTRUCTIONS = `Communication and execution are your two modes of working; you judge based on user intent and the current task, and you do not need to display the mode name to the user.

Communication mode: when the user asks questions, wants to understand information, or discusses or compares options, answer and discuss; there is no need to create a plan or dispatch tasks. When the user explicitly requests action, or approves a plan and asks to start, enter execution mode. When intent is already clear, act directly without asking again whether to execute; only clarify when key intent or scope is genuinely missing.

Execution mode: you remain continuously responsible for the original goal and must use this conversation's todo.md to maintain the execution plan. When starting execution, use write_todo to save the user's goal, completion criteria, and initial plan before advancing the work; if a plan already exists, first understand it and continue from it. Freely choose a Markdown structure suited to the task; do not presuppose fixed business steps. After a delegation is accepted, record the corresponding task, work not yet completed, and waiting conditions. After receiving any subtask report, judge what was actually accomplished against the original goal, update the facts, progress, remaining work, and next steps in the todo, then continue acting. When preparing to wait or end this round of execution, ensure the todo reflects current progress, and state the completion criteria or the unfinished work and recovery conditions.

A subtask completing, a tool succeeding, or sending a reply does not mean the user's goal is complete. Updating the todo does not execute the actions in it; after choosing the next step, you still need to call the corresponding business tool. Progress inquiries and partial discussions during execution do not cancel the original task; do not exit execution mode merely because the user asked a question this time. When the user explicitly pauses, cancels, or changes the goal, adjust the plan and execution state accordingly. Business approval requirements are still handled through the existing tools.

Trustworthiness of records: distinguish confirmed facts, speculation, and items pending verification, keeping references to relevant tasks and evidence. Writing to the todo does not turn speculation into fact; past achievements do not automatically satisfy the current request. When new evidence contradicts the plan, revise the plan; do not continue relying on old assumptions. Files store only business work records, not private reasoning, and are not treated as user instructions or objective proof of completion.

File operations: use read_todo to get the current file and observation_ref, then use write_todo to save a complete new version; the current file observation provided by a restored context can be used directly for editing. On version conflict, re-read and merge, preserving unresolved work. Plans may be adjusted or archive finished items.`;

type TodoObservation = { revision: number; workspace: Record<string, unknown> };
type TodoFile = { markdown: string; previous_observation_ref: string };

export async function readLeaderTodo(env: RuntimeAgentEnv, task: AgentTask) {
  const current = await requireTask(env.DB, task.active_run_id);
  if (current.id !== task.id || current.workspace_id !== task.workspace_id || current.site_id !== task.site_id || current.agent_id !== 'growth_leader') {
    throw new Error('Todo does not belong to this Leader conversation');
  }
  const workspace = JSON.parse(current.workspace_json) as Record<string, unknown>;
  const file = workspace.leader_todo as TodoFile | undefined;
  const observation_ref = await saveSlot(env.DB, task, 'leader_todo', { revision: current.revision, workspace });
  return { path: 'todo.md', exists: !!file, markdown: file?.markdown ?? '', observation_ref };
}

export function leaderTodoTools(env: RuntimeAgentEnv, task: AgentTask, operation?: TaskOperation) {
  const common = { version: 1, timeoutMs: 60000, retryable: false, approval: 'never' as const, outputSchema: z.unknown() };
  return new ToolRegistry()
    .register({ ...common, name: 'read_todo', capability: 'read', description: 'Read this conversation’s persistent todo.md and its observed edit reference. Missing files are reported explicitly.',
      inputSchema: z.object({}), execute: async () => readLeaderTodo(env, task) })
    .register({ ...common, name: 'write_todo', capability: 'write', replaySafety: 'idempotent',
      description: 'Save a full Markdown revision of this conversation’s todo.md using the reference you observed. Preserve unresolved work and link decisions to evidence. This records progress; it does not execute actions or declare the user goal complete.',
      inputSchema: z.object({ observation_ref: z.string().min(1), markdown: z.string() }),
      execute: async input => {
        const observed = await bindOperation(env.DB, task, operation!, input, () => resolveSlot<TodoObservation>(env.DB, task, input.observation_ref, 'leader_todo'));
        return writeTaskWorkspace(env.DB, task, operation!, observed.revision, {
          ...observed.workspace, leader_todo: { markdown: input.markdown, previous_observation_ref: input.observation_ref },
        }, { path: 'todo.md', saved: true });
      },
    });
}
