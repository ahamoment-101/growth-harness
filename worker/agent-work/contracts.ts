import type { WorkNode, WorkResponse, WorkResponseReceipt } from '../../shared/agent-work';
import type { AgentTask } from '../agent-runtime/task-store';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import type { TeamScope } from '../team-status/signals';

export type WorkRequestContext = TeamScope & { task: AgentTask };
export type WorkProvider = {
  id: string;
  /** Domain registration, not a branch in the stream renderer or response router. */
  agents?: readonly string[];
  pending?: (scope: TeamScope, agentId: string) => Promise<Array<{ task_id: string; request_id: string; label: string; at: string }>>;
  read?: (context: WorkRequestContext) => Promise<WorkNode[]>;
  respond: (env: RuntimeAgentEnv, context: WorkRequestContext, input: WorkResponse, actorId: string) => Promise<WorkResponseReceipt>;
};
