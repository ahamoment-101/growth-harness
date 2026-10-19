import type { BubbleKind, BubbleReason } from '../../shared/team-status';

/**
 * One observed fact about one Agent, before anything is merged. Sources emit signals;
 * the merge turns every Agent's signals into at most one bubble. A signal usually stands
 * for one thing (count 1); a source may pre-aggregate.
 */
export type TeamSignal = {
  task_id?: string;
  agent_id: string;
  kind: BubbleKind;
  reason: BubbleReason;
  count: number;
  peer_agent_id: string;
  at: string;
};

export type TeamScope = { db: D1Database; workspaceId: string; siteId: string };

/** Reads one kind of state for a site. Adding a source never changes the others or the merge. */
export type SignalSource = (scope: TeamScope) => Promise<TeamSignal[]>;
