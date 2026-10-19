import type { TeamStatus } from '../../shared/team-status';
import { mergeBubbles } from './merge';
import type { SignalSource, TeamScope, TeamSignal } from './signals';
import { SIGNAL_SOURCES } from './sources';

export { markSeen, markAllHistorySeen } from './seen';

/** The classroom's bubbles for a site's team. `team` lists the Agents that appear in the classroom. */
export async function readTeamStatus(scope: TeamScope, team: readonly string[], sources: readonly SignalSource[] = SIGNAL_SOURCES): Promise<TeamStatus> {
  return teamStatusFromSignals((await Promise.all(sources.map((source) => source(scope)))).flat(), team);
}

/** Pure: shared by the polled view and the live SiteRoom projection. */
export function teamStatusFromSignals(signals: readonly TeamSignal[], team: readonly string[]): TeamStatus {
  const all = signals.filter((s) => team.includes(s.agent_id));
  return { bubbles: mergeBubbles(all, team), figures: {
    working: new Set(all.filter((s) => ['working', 'waiting_on_teammate', 'waiting_external'].includes(s.kind)).map((s) => s.agent_id)).size,
    pending: all.filter((s) => s.kind === 'needs_you' || s.kind === 'stuck').reduce((sum, s) => sum + s.count, 0),
  } };
}
