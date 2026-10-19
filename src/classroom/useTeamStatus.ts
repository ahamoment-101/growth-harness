import { useCallback, useMemo } from 'react';
import type { AgentBubble, TeamStatus } from '../../shared/team-status';
import { api } from '../api';
import { useRoomTopic } from '../site-room';

/** The classroom's bubbles, pushed by the site's live room; no polling. */
export function useTeamStatus(siteId: string) {
  const { data, connected, error: failure } = useRoomTopic<TeamStatus>(siteId, 'team');
  const markSeen = useCallback(async (agentId: string, taskId: string, at: string) => {
    // The receipt reaches this view through the room like any other change.
    await api.markTeamSeen(siteId, agentId, taskId, at);
  }, [siteId]);
  const bubbles = data?.bubbles ?? [];
  const byAgent = useMemo(() => new Map(bubbles.map((b) => [b.agent_id, b])), [bubbles]);
  // Only a connection that has already delivered state and then dropped is worth mentioning.
  const error = failure ? 'Status temporarily unreadable, retrying automatically' : data && !connected ? 'Status updates interrupted, reconnecting' : '';
  return { bubbles, byAgent, markSeen, figures: data?.figures, error };
}

/** Counts visible signals; this is not the total task backlog. */
export function screenFigures(bubbles: readonly AgentBubble[]) {
  const busy = new Set(['working', 'waiting_on_teammate', 'waiting_external']);
  return {
    working: bubbles.filter((b) => busy.has(b.kind)).length,
    pending: bubbles.reduce((sum, b) => sum + (b.kind === 'needs_you' ? b.count : b.kind === 'stuck' ? 1 : 0), 0),
  };
}
