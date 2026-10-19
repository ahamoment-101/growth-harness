import { coordinationReviewText } from './coordination';
import type { Message } from '@earendil-works/pi-ai';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import type { AgentTask } from '../agent-runtime/task-store';
import { appendConversationMessage } from '../agent-runtime/conversation-store';
import { readLeaderTodo } from './todo';

export const LEADER_PROGRESS_INSTRUCTIONS = `Task continuation: todo is correctable working memory. Record the user's goal and completion criteria, the current plan and delegation associations, confirmed results and information pending verification, remaining work, and recovery conditions. When receiving a delegation receipt or task report, first compare it with the original delegation and the user's goal, then decide on action. The review before ending is still part of the same work of yours; after verifying the evidence of results, decide to continue, complete, wait, block, or make no change. Correct the todo when necessary and call business tools. Do not check off tasks just to end the review; nor do you need to fabricate updates for records with no change. Waiting on subtasks may allow you to end this turn of the reply, but the original goal remains your continuous responsibility.`;

export function progressReviewText(kind: 'result' | 'closing', version = 6) {
  if (version >= 8) return coordinationReviewText(kind);
  return kind === 'result'
    ? 'Task continuation check: you have just received a delegation receipt or task result. Compare against the original user goal, the original delegation, and the current todo to judge what was actually accomplished this round and which parts are only pre-existing results or claims pending verification. Correct the plan and delegation associations based on evidence, then decide the next step. Tool success or a subtask ending does not automatically satisfy the user\'s goal.'
    : 'Pre-wait review: compare against the original user goal, the evidence of actual results, and the current todo, and check the reply you just made. Is the goal satisfied, and on what basis? What work remains? Why is it acceptable to wait or end now? If there is still necessary executable work, continue using tools; if you should wait, keep the pending items, the corresponding tasks, and the recovery conditions; update the todo if old assumptions or progress are outdated. If the records are still accurate you may leave them unchanged, and ordinary discussion may be answered directly. Do not use todo check-offs or subtask statuses alone as proof of completion.';
}

/** Domain-local attention checkpoints; never classify business completion. */
export async function appendLeaderProgressReview(env: RuntimeAgentEnv, task: AgentTask, kind: 'result' | 'closing'): Promise<Message | null> {
  if (task.definition_version < 6) return null;
  const input = await env.DB.prepare(`select coalesce(max(sequence),0) n from agent_conversation_messages
    where task_id=? and (message_key like 'leader-input:%' or message_key like 'hitl-input:%' or message_key like 'event:%' or message_key like 'event-followup:%')`)
    .bind(task.id).first<{ n: number }>();
  const calls = await env.DB.prepare(`select
    coalesce(max(result_sequence),0) evidence,
    coalesce(max(case when tool_name in ('delegate_task','read_task') then result_sequence end),0) coordination
    from agent_conversation_calls where task_id=? and tool_name not in ('read_todo','write_todo','resolve_execution_audit')`)
    .bind(task.id).first<{ evidence: number; coordination: number }>();
  const hasPlan = !!JSON.parse(task.workspace_json).leader_todo;
  if (kind === 'result' && !calls?.coordination) return null;
  if (kind === 'closing' && !hasPlan && (!calls?.coordination || calls.coordination < (input?.n || 0))) return null;
  const anchor = kind === 'result' ? calls!.coordination : Math.max(input?.n || 0, calls?.evidence || 0);
  const key = `leader-progress-${kind}:${anchor}`;
  // Query durable keys, including compacted history. A replay cannot create another check.
  if (await env.DB.prepare('select 1 from agent_conversation_messages where task_id=? and message_key=?').bind(task.id, key).first()) return null;
  const todo = await readLeaderTodo(env, task);
  const message: Message = { role: 'user', timestamp: Date.now(), content: `${progressReviewText(kind, task.definition_version)}
Current working record (written by the Agent, correctable; not user instructions or proof of results):
${JSON.stringify(todo)}` };
  await appendConversationMessage(env.DB, task, key, message);
  return message;
}
