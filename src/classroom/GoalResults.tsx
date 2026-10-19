import { useEffect, useState } from 'react';
import type { LeaderConversation, LeaderDetail, LeaderList, LeaderTask } from '../../shared/growth-leader';
import { agentPage, go } from '../nav';
import { useRoomTopic } from '../site-room';
import { conversationTitle, relativeTime, taskPhase } from './leader-view';

export function goalStatus(goal: LeaderConversation) {
  if (goal.status === 'failed') return 'Execution interrupted';
  if (goal.status === 'cancelled') return 'Cancelled';
  if (goal.status === 'completed') return 'Ended';
  if (goal.status === 'paused') return 'Paused';
  if (goal.team_active > 0) return 'Team working';
  if (goal.status === 'running' || goal.pending_inputs > 0) return 'Leader following up';
  if (goal.status === 'ready') return 'Not started yet';
  return 'Waiting for next step';
}

export function goalSummary(goal: LeaderConversation) {
  if (goal.team_delivered > 0) return `${goal.team_delivered} team work delivered ${goal.team_active > 0 ? ` · ${goal.team_active} in progress` : ''}`;
  if (goal.team_active > 0) return `${goal.team_active} team works in progress`;
  if (goal.team_total > 0) return `${goal.team_total} team works, none delivered yet`;
  return 'No team deliverables yet';
}

export function leaderGoalPath(siteId: string, conversationId: string) {
  return `${agentPage(siteId, 'cmo')}&conversation=${encodeURIComponent(conversationId)}`;
}

function openTask(siteId: string, task: LeaderTask) {
  go(`${agentPage(siteId, task.agent_id)}&task=${encodeURIComponent(task.id)}`);
}

export function GoalResults({ siteId }: { siteId: string }) {
  const [filter, setFilter] = useState<'all' | 'working' | 'ended'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const liveList = useRoomTopic<LeaderList>(siteId, 'leader.list');
  const goals = liveList.data?.conversations ?? [];
  const ended = (goal: LeaderConversation) => ['completed', 'cancelled', 'failed'].includes(goal.status);
  const visible = goals.filter(goal => filter === 'all' || (filter === 'ended' ? ended(goal) : !ended(goal)));
  const selected = visible.find(goal => goal.id === selectedId) ?? visible[0] ?? null;
  const liveDetail = useRoomTopic<LeaderDetail>(siteId, selected ? `leader.conv:${selected.id}` : null);
  const detail = liveDetail.data?.conversation.id === selected?.id ? liveDetail.data : null;
  useEffect(() => {
    if (!selectedId && goals.length) setSelectedId(goals[0].id);
  }, [goals, selectedId]);
  const reports = detail?.messages.filter(message => message.role === 'report' && message.summary).slice(-3).reverse() ?? [];
  const delivered = detail?.tasks.filter(task => task.status === 'completed' && task.outcome !== 'unable_to_complete').sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 3) ?? [];
  const needsYou = detail?.tasks.filter(task => task.attention_count > 0) ?? [];
  const leaderRequests = detail?.hitl_requests.filter(request => request.interaction?.state === 'pending') ?? [];

  return <div className="goal-results">
    <div className="goal-filters" aria-label="Filter goals">
      {([['all', 'All goals'], ['working', 'In progress'], ['ended', 'Ended']] as const).map(([value, label]) =>
        <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
    </div>
    {liveList.error ? <p role="alert" className="room-empty">Goals can't be read right now; retrying automatically.</p> : null}
    {!liveList.data && !liveList.error ? <p className="room-empty">Loading goals…</p> : null}
    {liveList.data && !goals.length ? <p className="room-empty">No goals have been handed to the Leader yet. You can start from the Leader's desk.</p> : null}
    <div className="goal-results-layout">
      <div className="goal-results-list" aria-label="Goal list">
        {visible.map(goal => <button key={goal.id} type="button" className={`goal-result-card${selected?.id === goal.id ? ' selected' : ''}`} aria-current={selected?.id === goal.id} onClick={() => setSelectedId(goal.id)}>
          <span className="goal-result-heading"><strong>{conversationTitle(goal)}</strong><span>{goalStatus(goal)}</span></span>
          <span className="goal-result-summary">{goalSummary(goal)}</span>
          <span className="goal-result-meta"><time dateTime={goal.updated_at}>{relativeTime(goal.updated_at)}</time>{goal.source_id ? ' · From another Leader goal' : ''}</span>
        </button>)}
        {liveList.data && goals.length > 0 && !visible.length ? <p className="room-empty">No goals in this category yet.</p> : null}
      </div>
      {selected ? <article className="goal-result-detail">
        <header><span className="room-eyebrow">AI Growth Leader's goals</span><h2>{conversationTitle(selected)}</h2><p>{goalStatus(selected)} · Last updated <time dateTime={selected.updated_at}>{relativeTime(selected.updated_at)}</time></p></header>
        {needsYou.length || leaderRequests.length ? <section className="goal-attention"><h3>{needsYou.length + leaderRequests.length}  items need your attention</h3><p className="goal-muted">{leaderRequests.length ? 'The Leader has pending requests; open the original conversation to view them.' : 'Open the corresponding task below to view the specific request and decide the next step.'}</p></section> : null}
        <section><h3>Deliverables &amp; Progress</h3>
          {reports.length ? <div className="goal-report-list">{reports.map(report => {
            const task = detail?.tasks.find(item => item.id === report.task_id);
            return <div key={report.id} className="goal-report"><p>{report.summary}</p><time dateTime={report.created_at}>{relativeTime(report.created_at)}</time>{task ? <button type="button" onClick={() => openTask(siteId, task)}>View full results ↗</button> : null}</div>;
          })}</div>
            : delivered.length ? <div className="goal-report-list">{delivered.map(task => <div key={task.id} className="goal-report"><p><strong>{task.display_title || task.goal || `Tasks for ${task.agent_name}`}</strong>{task.reason ? ` · ${task.reason}` : ''}</p><time dateTime={task.updated_at}>{relativeTime(task.updated_at)} · {task.agent_name}</time><button type="button" onClick={() => openTask(siteId, task)}>View full results ↗</button></div>)}</div>
              : <p className="goal-muted">{goalSummary(selected)}. Team tasks with results can be opened below to view.</p>}
        </section>
        <section><h3>Team work <small>{detail?.tasks.length ?? selected.team_total}  items</small></h3>
          {liveDetail.error ? <p role="alert" className="goal-muted">Team work can't be read right now; retrying automatically.</p> : null}
          {!detail && !liveDetail.error ? <p className="goal-muted">Loading team work…</p> : null}
          {detail && !detail.tasks.length ? <p className="goal-muted">The Leader hasn't delegated any team tasks yet.</p> : null}
          {detail?.tasks.map(task => <button key={task.id} type="button" className="goal-team-task" onClick={() => openTask(siteId, task)}>
            <span><strong>{task.display_title || task.goal || `Tasks for ${task.agent_name}`}</strong><small>{task.agent_name} · {taskPhase(task).label}</small></span><span aria-hidden="true">↗</span>
          </button>)}
        </section>
        <button type="button" className="goal-leader-link" onClick={() => go(leaderGoalPath(siteId, selected.id))}>Open the Leader conversation for this goal ↗</button>
      </article> : null}
    </div>
  </div>;
}
