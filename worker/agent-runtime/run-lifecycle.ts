import type { D1Database } from '@cloudflare/workers-types';
import { markContentGroupAttention } from './content-production';
import type { AgentId } from './definitions';
import type { AgentRun } from './protocol';
import { stopStrategyResearchRun } from './strategy-control';

type CancellationHandler = (db: D1Database, run: AgentRun, reason: string) => Promise<void>;

const terminalFailureHandlers: Partial<Record<AgentId, CancellationHandler>> = {
  strategy_research: async (db, run, reason) => {
    await stopStrategyResearchRun(db, run.id, reason || 'Cancelled by user');
  },
  content_production: async (db, run, reason) => {
    const summary = JSON.parse(run.summary_json || '{}') as Record<string, unknown>;
    const groupId = String(summary.group_id || '');
    if (groupId) await markContentGroupAttention(db, groupId, reason || 'Content production was cancelled by user');
  },
};

export async function reconcileCancelledAgentRun(
  db: D1Database,
  run: AgentRun,
  reason: string,
): Promise<void> {
  const handler = terminalFailureHandlers[run.agent_id as AgentId];
  if (handler) await handler(db, run, reason);
}

export async function reconcileFailedAgentRun(
  db: D1Database,
  run: AgentRun,
  reason: string,
): Promise<void> {
  const handler = terminalFailureHandlers[run.agent_id as AgentId];
  if (handler) await handler(db, run, reason);
}
