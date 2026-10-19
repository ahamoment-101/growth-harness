import type { RosterMember } from './agent-roster';
export type AgentActivity = {
  id: string; task_id: string; agent_id: string; agent_name: string;
  kind: 'started' | 'completed'; at: string; title: string;
};
export type AgentActivityPage = { entries: AgentActivity[]; agents: RosterMember[]; next_cursor: string | null };
