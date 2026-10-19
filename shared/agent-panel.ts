import type { WorkStream } from './agent-work';
import type { CabinetDocument } from './cabinet-document';
// The classroom panels' HTTP payloads. Business documents retain their own shape.
export type PanelTask = {
  id: string; agent_id: string; active_run_id: string; status: string; outcome: string;
  reason: string; agent_instance_id: string; parent_task_id: string; created_at: string; updated_at: string;
  unread?: boolean; display_title?: string; work_state?: 'current' | 'history'; attention_count?: number;
};
export type PanelTodo = { id: string; label: string; href?: string; task_id?: string; request_id?: string; at: string };
export type AgentPanelList = { tasks: PanelTask[]; next_cursor: string | null; todos: PanelTodo[]; unread_history_count: number };
export type AgentPanelDetail = {
  task: PanelTask;
  work: WorkStream;
  goal: unknown;
  output: unknown;
  files: CabinetDocument[];
  draft: { content: unknown; version: number; status: string; updatedAt: string } | null;
  execution: { execution_state: string; recovery_reason: string; next_recovery_at: string; allowed_actions: string[] };
  activity: Array<{ id: string; name: string; status: string; error: string; created_at: string; updated_at: string }>;
  children: PanelTask[];
  usage: { input_tokens: number; output_tokens: number; cost_usd: number; started_at: string; finished_at: string };
};
