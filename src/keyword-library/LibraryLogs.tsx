import type { LibraryLog, LibraryLanguage } from '../../shared/keyword-library';
import { ACTION_LABELS, FIELD_LABELS, text } from './format';
import type { LibrarySource } from './source';
import { usePages } from './usePages';

export function LibraryLogs({ source, siteId, language, actor, target, compact = false }: {
  source: LibrarySource; siteId: string; language: LibraryLanguage; actor: string; target?: string; compact?: boolean;
}) {
  const state = usePages<LibraryLog>(async after => {
    const r = await source.logs(siteId, language, { after, actor_type: actor || undefined, target_id: target });
    return { items: r.items, next: r.next ? JSON.stringify(r.next) : null };
  });
  return <div className={`kl-logs${compact ? ' compact' : ''}`}>
    {state.items.map(log => <details key={log.id} className="kl-log">
      <summary>
        <span className={`kl-actor ${log.actor.type}`}>{log.actor.type === 'agent' ? 'AI' : 'by'}</span>
        <span className="kl-log-main"><strong>{ACTION_LABELS[log.action] || log.action}</strong><span>{log.reason}</span></span>
        <time dateTime={log.created_at}>{new Date(log.created_at).toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
      </summary>
      <div className="kl-log-body">
        <table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
          {log.changes.map(c => <tr key={c.field}><th>{FIELD_LABELS[c.field] || c.field}</th><td>{text(c.before)}</td><td>{text(c.after)}</td></tr>)}
        </tbody></table>
        <small>{log.actor.id}{log.actor.task_id ? ` · Task ${log.actor.task_id}` : ''} · Version {log.receipt.revision}</small>
      </div>
    </details>)}
    {state.error ? <p className="kl-error" role="alert">{state.error} <button className="btn sm" onClick={state.retry}>Retry</button></p> : null}
    {state.loading ? <p className="kl-muted">Loading…</p> : null}
    {!state.loading && !state.error && !state.items.length ? <p className="kl-muted">No change history yet</p> : null}
    {state.next && !state.loading ? <button className="btn sm" onClick={state.more}>Load more</button> : null}
  </div>;
}
