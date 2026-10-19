import { BUBBLE_KINDS, type AgentBubble } from '../../shared/team-status';
import type { TeamSignal } from './signals';

/** Latest effective item wins. Reading a completion never dismisses an outstanding action. */
export function mergeBubbles(signals: readonly TeamSignal[], team: readonly string[]): AgentBubble[] {
  return team.flatMap((agentId) => {
    const own = signals.filter((s) => s.agent_id === agentId);
    own.sort((a, b) => b.at.localeCompare(a.at) || BUBBLE_KINDS.indexOf(a.kind) - BUBBLE_KINDS.indexOf(b.kind) || (a.task_id ?? '').localeCompare(b.task_id ?? ''));
    return own[0] ? [{ ...own[0] }] : [];
  });
}
