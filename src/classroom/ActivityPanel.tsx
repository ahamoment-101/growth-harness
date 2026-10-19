import { useEffect, useState } from 'react';
import { api } from '../api';
import { useRoomTopic } from '../site-room';
import type { AgentActivityPage } from '../../shared/agent-activity';
import { GoalResults } from './GoalResults';
import './panels.css';
import './activity.css';

export function ActivityPanel({ siteId }: { siteId: string }) {
  const [tab, setTab] = useState<'results' | 'activity'>('results');
  return <section className="room-panel activity-panel">
    <header className="room-panel-heading"><div><span className="room-eyebrow">Classroom · Team Progress</span><h1>Goals and Results</h1><p>Starting from goals handed to the AI Growth Leader, view team deliverables and next steps.</p></div></header>
    <div className="activity-tabs" role="tablist" aria-label="Team Progress View">
      <button type="button" role="tab" aria-selected={tab === 'results'} className={tab === 'results' ? 'selected' : ''} onClick={() => setTab('results')}>Goal Outcomes</button>
      <button type="button" role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'selected' : ''} onClick={() => setTab('activity')}>Agent Activity Detail</button>
    </div>
    {tab === 'results' ? <div role="tabpanel"><GoalResults siteId={siteId} /></div> : <div role="tabpanel"><AgentActivityLog siteId={siteId} /></div>}
  </section>;
}

function AgentActivityLog({ siteId }: { siteId: string }) {
  const [agentId, setAgentId] = useState('');
  // The newest page of everyone's work is pushed live; a colleague filter and older pages are read on demand.
  const live = useRoomTopic<AgentActivityPage>(siteId, 'activity');
  const [filtered, setFiltered] = useState<AgentActivityPage | null>(null);
  const [older, setOlder] = useState<{ entries: AgentActivityPage['entries']; next_cursor: string | null | undefined }>({ entries: [], next_cursor: undefined });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setOlder({ entries: [], next_cursor: undefined });
    setFiltered(null);
    if (!agentId) return;
    let live = true;
    setLoading(true);
    api.agentActivity(siteId, '', agentId)
      .then(page => { if (live) { setFiltered(page); setError(''); } })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : 'Failed to load activity'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [siteId, agentId, reload]);
  const base = agentId ? filtered : live.data ?? null;
  const data = base && { ...base, next_cursor: older.next_cursor === undefined ? base.next_cursor : older.next_cursor };
  const entries = [...(base?.entries ?? []), ...older.entries.filter(entry => !base?.entries.some(item => item.id === entry.id))];
  async function loadMore() {
    if (!data?.next_cursor || loading) return;
    setLoading(true);
    try {
      const page = await api.agentActivity(siteId, data.next_cursor, agentId);
      setOlder(previous => ({ entries: [...previous.entries, ...page.entries], next_cursor: page.next_cursor }));
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load activity'); }
    finally { setLoading(false); }
  }
  const setCursor = (_: string) => void loadMore();
  const shownError = error || (!agentId && live.error ? 'Activity is temporarily unavailable' : '');
  return <>
    <div className="room-activity-tools">
      <select aria-label="Filter by Agent" value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">All teammates</option>{live.data?.agents.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.name}</option>)}</select>
      {agentId ? <button type="button" disabled={loading} onClick={() => setReload(value => value + 1)}>Refresh</button> : null}
    </div>
    {shownError ? <p role="alert">Update failed: {shownError} <button type="button" onClick={() => { setError(''); setReload(value => value + 1); }}>Retry</button></p> : null}
    <div className="activity-log" aria-busy={loading}>
      {entries.map((entry, index) => {
        const date = new Date(entry.at).toLocaleDateString('en-US');
        const previousDate = index ? new Date(entries[index - 1].at).toLocaleDateString('en-US') : '';
        return <div key={entry.id}>{date !== previousDate ? <div className="room-day-label">{date}</div> : null}
          <article className="activity-entry"><div className="activity-entry-top"><strong>{entry.agent_name}</strong><time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</time></div><p>{entry.title}</p></article>
        </div>;
      })}
      {!entries.length ? <p className="room-empty">{loading || !base ? 'Loading activity…' : shownError ? 'Activity is temporarily unavailable.' : 'No started or completed work records yet.'}</p> : null}
    </div>
    {data?.next_cursor ? <button type="button" className="activity-more" disabled={loading} onClick={() => setCursor(data.next_cursor!)}>{loading ? 'Loading…' : 'Load more'}</button> : null}
  </>;
}
