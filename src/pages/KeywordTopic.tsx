import { useEffect, useState } from 'react';
import type { Site } from '../api';
import type { LibraryTopic } from '../../shared/keyword-library';
import { Shell } from '../components/Shell';
import { Link } from '../nav';
import { languageLabel } from '../keyword-library/format';
import { libraryHref } from '../keyword-library/links';
import { DifficultyCell, StatusPill, TrendCell, VolumeCell } from '../keyword-library/SearchCells';
import { librarySource } from '../keyword-library/source';
import '../keyword-library/keyword-library.css';

export default function KeywordTopic({ site, sites, topicId }: { site: Site; sites: Site[]; topicId: string }) {
  const source = librarySource();
  const params = new URLSearchParams(location.search);
  const language = { locale: params.get('locale') || site.source_locale };
  const [data, setData] = useState<LibraryTopic | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true); setError('');
    source.topic(site.id, language, topicId).then(r => { if (live) setData(r); })
      .catch(cause => { if (live) setError((cause as Error).message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [source, site.id, topicId, language.locale, retry]);
  async function more() {
    if (busy || !data?.next) return;
    setBusy(true); setError('');
    try { const r = await source.topic(site.id, language, topicId, data.next); setData({ ...r, keywords: [...data.keywords, ...r.keywords] }); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  const back = libraryHref(site.id, language);
  return <Shell site={site} sites={sites} active="keywords" crumb={<><Link to={back}>Keyword Library</Link><span className="sep">›</span><span className="cur">Topic Selection</span></>}>
    <div className="kl-page">
      <Link className="kl-back" to={back}>← Back to Keyword Library</Link>
      {error ? <p className="kl-error" role="alert">{error} <button className="btn sm" onClick={() => data ? void more() : setRetry(r => r + 1)}>Retry</button></p> : null}
      {busy && !data ? <p className="kl-muted kl-pad">Loading…</p> : null}
      {data ? <>
        <header className="kl-heading">
          <div>
            <h1>{data.topic.title_hint}</h1>
            <p>{languageLabel(language)} · {data.topic.status} · {data.topic.category} · Primary keywords: {data.topic.primary_keyword || 'Not recorded'}</p>
          </div>
        </header>
        <h2 className="kl-subhead">Keywords used for this topic</h2>
        <div className="kl-table-wrap">
          <table className="kl-table">
            <thead><tr><th className="kl-col-name">Keyword</th><th>Relation</th><th className="num">Monthly search volume</th><th className="num">Difficulty</th><th className="kl-col-trend">12-month trend</th><th className="kl-col-status">Data</th></tr></thead>
            <tbody>{data.keywords.map(k => <tr key={k.id}>
              <td className="kl-col-name"><strong className="kl-word-static">{k.name}</strong></td>
              <td className="kl-muted">{k.relationship}</td>
              <td className="num"><VolumeCell data={k.search_data} /></td>
              <td className="num"><DifficultyCell data={k.search_data} /></td>
              <td className="kl-col-trend"><TrendCell data={k.search_data} /></td>
              <td className="kl-col-status"><StatusPill data={k.search_data} /></td>
            </tr>)}</tbody>
          </table>
          {!data.keywords.length ? <div className="kl-empty"><p>No related keywords in the current language.</p></div> : null}
        </div>
        <div className="kl-foot">{data.next ? <button className="btn sm" disabled={busy} onClick={more}>Load more</button> : null}<span className="kl-muted">Topic ID: {data.topic.id}</span></div>
      </> : null}
    </div>
  </Shell>;
}
