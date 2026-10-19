import { useEffect, useState } from 'react';
import { api, type DailyTrigger, type Site } from '../api';
import { Shell } from '../components/Shell';
import { Link, sitePage } from '../nav';
import './Triggers.css';

export default function Triggers({ site, sites }: { site: Site; sites: Site[] }) {
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState('09:00');
  const [action, setAction] = useState<'start_topic_batch'>('start_topic_batch');
  const [saved, setSaved] = useState<DailyTrigger | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let live = true;
    api.dailyTrigger(site.id).then(({ trigger }) => {
      if (!live) return;
      setSaved(trigger);
      setEnabled(Boolean(trigger?.enabled));
      setTime(trigger?.local_time || '09:00');
      setAction(trigger?.action || 'start_topic_batch');
      setLoaded(true);
    }).catch((cause: unknown) => {
      if (!live) return;
      setError(cause instanceof Error ? cause.message : 'Failed to load trigger configuration');
    });
    return () => { live = false; };
  }, [site.id]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api.saveDailyTrigger(site.id, {
        enabled, task_mode: 'scheduled', action, local_time: time,
      });
      setSaved(result.trigger);
      setMessage('Trigger configuration saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Save failed');
    } finally { setBusy(false); }
  }

  return <Shell sites={sites} site={site} active="triggers" crumb={<>
    <Link className="muted" to={sitePage(site.id)}>Main screen</Link><span className="sep">›</span>
    <Link className="muted" to={sitePage(site.id, 'seo')}>Data Analytics</Link><span className="sep">›</span>
    <span className="cur">Trigger Mechanism</span>
  </>} actions={<button className="btn primary" type="button" onClick={() => void save()} disabled={!loaded || busy}>{busy ? 'Saving…' : 'Save'}</button>}>
    <div className="pad trigger-page">
      <header className="trigger-page-head">
        <p className="business-eyebrow">TRIGGERS</p>
        <h1>Trigger Mechanism</h1>
        <p>Wake the AI Growth Leader at the set time so it can coordinate the team in that day's topic-selection conversation.</p>
      </header>
      {error ? <p className="flash" role="alert">{error}</p> : null}
      {message ? <p className="trigger-success" role="status">{message}</p> : null}
      {!loaded ? <p className="empty">Loading…</p> : <section className="section trigger-config" aria-label="Scheduled task configuration">
        <div className="section-head"><h2 className="section-title">Scheduled task</h2></div>
        <p className="section-note">Fires once per day at the scheduled time. The topic-selection Task and subsequent results will remain in the Leader's topic-selection conversation for that day.</p>
        <div className="kv"><label className="kv-k" htmlFor="trigger-enabled">Enable scheduled task</label>
          <div className="kv-v"><input id="trigger-enabled" type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span>{enabled ? 'Enabled' : 'Not enabled'}</span></div></div>
        <div className="kv"><label className="kv-k" htmlFor="trigger-mode">Task mode</label>
          <div className="kv-v"><select id="trigger-mode" className="input" value="scheduled" disabled><option value="scheduled">Scheduled task</option></select></div></div>
        <div className="kv"><label className="kv-k" htmlFor="trigger-time">Daily time<span className="sub">China Standard Time UTC+8</span></label>
          <div className="kv-v"><input id="trigger-time" className="input" type="time" required value={time} onChange={event => setTime(event.target.value)} /></div></div>
        <div className="kv"><label className="kv-k" htmlFor="trigger-action">Trigger content</label>
          <div className="kv-v"><select id="trigger-action" className="input" value={action} onChange={event => setAction(event.target.value as 'start_topic_batch')}>
            <option value="start_topic_batch">Kick off a batch of topics</option>
          </select></div></div>
        {saved?.enabled && saved.next_due_at ? <p className="trigger-next">Next trigger: {new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(saved.next_due_at))}(China Standard Time)</p> : null}
      </section>}
    </div>
  </Shell>;
}
