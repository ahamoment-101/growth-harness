import type { ConfigurationView } from './useLeaderConfiguration';
import { LedgerScreen } from './LedgerScreen';
import type { Site } from '../api';
import type { LeaderList } from '../../shared/growth-leader';
import { useRoomTopic } from '../site-room';
import { go, sitePage } from '../nav';
import { conversationTitle, relativeTime } from './leader-view';
import { goalStatus, goalSummary } from './GoalResults';
import { Icon } from './ui';
import { FilingCabinet } from './FilingCabinet';

// The three screens at the front of the classroom read as one timeline: the left screen is
// the team right now, the centre screen what it has produced so far, the right screen goals
// followed by the Leader. Both side screens open recorded team progress.

type TeamScreenProps = { site: Site; headcount: number; working: number; pending: number; configuration: ConfigurationView; statusReady: boolean };

export function ScreenWall({ site, headcount, working, pending, configuration, statusReady }: TeamScreenProps) {
  return (
    <div className="room-front">
      <TeamScreen site={site} headcount={headcount} working={working} pending={pending} configuration={configuration} statusReady={statusReady} />
      <LedgerScreen site={site} />
      <GoalScreen site={site} />
      <div className="room-furnishings"><FilingCabinet site={site} /></div>
    </div>
  );
}

/** Left: the team right now. */
export function TeamScreen({ site, headcount, working, pending, configuration, statusReady }: TeamScreenProps) {
  return (
    <button type="button" className="big-screen side left" onClick={() => go(sitePage(site.id, 'room-activity'))} aria-label="Open team progress">
      <span className="screen-glass team-screen">
        <span className="side-title">{configuration.state === 'checking' ? 'Checking model setup…' : configuration.state === 'unavailable' ? 'Model setup unknown' : configuration.state !== 'configured' ? 'Model setup required' : !statusReady ? 'Team status unavailable' : working > 0 ? 'The team is working' : pending > 0 ? 'Your input is needed' : 'The team is idle'}</span>
        <span className="screen-sub">{statusReady ? `${pending} things awaiting your decision` : 'Waiting for team status…'}</span>
        <span className="team-rows">
          <span className="team-row"><span className="chip-icon">{Icon.social}</span>employees<b>{headcount}</b></span>
          <span className="team-row"><i className="dot ok" />Working<b>{statusReady ? working : '—'}</b></span>
          <span className="team-row"><i className="dot bad" />awaiting your action<b>{statusReady ? pending : '—'}</b></span>
        </span>
      </span>
    </button>
  );
}

/** Right: a glanceable view of Leader goals, not the individual Agent milestones. */
function GoalScreen({ site }: { site: Site }) {
  const live = useRoomTopic<LeaderList>(site.id, 'leader.list');
  const goals = live.data?.conversations.slice(0, 3) ?? [];
  return (
    <button type="button" className="big-screen side right" onClick={() => go(sitePage(site.id, 'room-activity'))} aria-label="Open goals and results">
      <span className="screen-glass log-screen">
        <span className="side-title">Goal Progress<small>Followed up by AI Growth Leader</small></span>
        <span className="log-list">
          {!goals.length ? <span className="log-what">{!live.data && !live.error ? 'Loading goals…' : live.error ? 'Failed to load goals, click to view' : 'No Leader goals yet'}</span> : null}
          {live.error && goals.length ? <span className="log-what">Update failed, showing last result</span> : null}
          {goals.map((goal) => (
            <span key={goal.id} className="log-item">
              <span className="log-entry-heading"><b>{conversationTitle(goal)}</b><span className="log-when">{relativeTime(goal.updated_at)}</span></span>
              <span className="log-what">{goalStatus(goal)} · {goalSummary(goal)}</span>
            </span>
          ))}
        </span>
      </span>
    </button>
  );
}
