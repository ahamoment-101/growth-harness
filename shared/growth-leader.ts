/** `updated_at` is the latest of creation, any input and the Run's own status change. */
export type LeaderConversation = { id: string; title: string; context: string; source_id: string; created_at: string; status: string; reason: string;
  updated_at: string; preview: string; team_active: number; team_delivered: number; team_total: number; pending_inputs: number };
/** Timeline in the order the Leader read it; `pending` inputs are accepted but not yet read. */
export type LeaderMessage = { id: string; role: 'user' | 'assistant' | 'report' | 'assignment' | 'task' | 'event'; text: string; created_at: string;
  pending?: boolean; task_id?: string; summary?: string };
export type LeaderTask = { id: string; agent_id: string; agent_name: string; status: string; outcome: string; reason: string; created_at: string; updated_at: string;
  display_title: string; goal: string; why: string; attention_count: number };
/** `has_earlier`: the live view shows only the recent part of a long conversation. */
export type LeaderDetail = { conversation: LeaderConversation; messages: LeaderMessage[]; tasks: LeaderTask[];
  hitl_requests: import('./agent-work').WorkNode[]; has_earlier?: boolean };
export type LeaderList = { conversations: LeaderConversation[] };
