import { useEffect, useState } from 'react';
import { libraryQuery, type Site } from '../api';
import type { LibraryEntryView, LibraryLanguage } from '../../shared/keyword-library';
import { Shell } from '../components/Shell';
import { ClusterView } from '../keyword-library/ClusterView';
import { languageLabel } from '../keyword-library/format';
import { KeywordPanel } from '../keyword-library/KeywordPanel';
import { KeywordTable } from '../keyword-library/KeywordTable';
import { LibraryLogs } from '../keyword-library/LibraryLogs';
import { librarySource } from '../keyword-library/source';
import '../keyword-library/keyword-library.css';

type View = 'keywords' | 'clusters' | 'logs';
const VIEWS: Array<[View, string]> = [['keywords', 'Keyword'], ['clusters', 'Topics and Keyword Clusters'], ['logs', 'Change history']];

export default function Keywords({ site, sites }: { site: Site; sites: Site[] }) {
  const source = librarySource();
  const [languages, setLanguages] = useState<LibraryLanguage[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<View>('keywords');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<{ id: string; name: string } | null>(null);
  const [archived, setArchived] = useState(false);
  const [actor, setActor] = useState('');
  const [selected, setSelected] = useState<LibraryEntryView | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    source.languages(site.id).then(r => {
      if (!live) return;
      setLanguages(r.languages);
      const params = new URLSearchParams(location.search);
      const found = r.languages.findIndex(m => m.locale === params.get('locale'));
      setIndex(found >= 0 ? found : 0);
    }).catch(cause => { if (live) setError((cause as Error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [site.id, source, refresh]);

  const language = languages[index];
  const identity = JSON.stringify([language, search, filter?.id, archived, actor, refresh]);
  function reset() { setFilter(null); setSearch(''); setDraft(''); setSelected(null); }
  function chooseLanguage(i: number) {
    setIndex(i); reset();
    history.replaceState(null, '', `${location.pathname}?${libraryQuery(languages[i])}`);
  }
  function applyFilter(parent: { id: string; name: string }) { setFilter(parent); setView('keywords'); setSearch(''); setDraft(''); }

  return <Shell sites={sites} site={site} active="keywords" crumb={<><span className="muted">GrowthHarness</span><span className="sep">›</span><span className="cur">Keyword Library</span></>}>
    <div className="kl-page">
      <header className="kl-heading">
        <div>
          <h1>Keyword Library</h1>
          <p>Search demand accumulated independently for each language. Search data is recorded by system queries; priorities and judgments are provided by the Keyword Researcher agent.</p>
        </div>
        <div className="kl-actions">
          <select aria-label="Language" disabled={!languages.length || loading} value={index} onChange={e => chooseLanguage(Number(e.target.value))}>
            {languages.length ? languages.map((m, i) => <option key={`${m.locale}`} value={i}>{languageLabel(m)}</option>) : <option value={0}>No keyword library yet</option>}
          </select>
          <button className="btn" disabled={loading} onClick={() => setRefresh(n => n + 1)}>Refresh</button>
        </div>
      </header>

      <nav className="kl-tabs">{VIEWS.map(([key, label]) => <button key={key} className={view === key ? 'on' : ''} onClick={() => { setView(key); setFilter(null); }}>{label}</button>)}</nav>

      {error ? <p className="kl-error" role="alert">{error} <button className="btn sm" onClick={() => setRefresh(n => n + 1)}>Retry</button></p> : null}
      {loading ? <p className="kl-muted kl-pad">Reading keyword library…</p> : null}
      {!loading && !error && !language ? <div className="kl-empty"><h3>This site doesn't have a keyword library yet</h3><p>Once the Strategist dispatches the Keyword Researcher, keywords for each language will appear here.</p></div> : null}

      {!loading && language ? <div className={`kl-body${selected ? ' with-panel' : ''}`}>
        <div className="kl-main">
          {view === 'keywords' ? <>
            <div className="kl-toolbar">
              <form onSubmit={e => { e.preventDefault(); setSearch(draft.trim()); setSelected(null); }}>
                <input aria-label="Search Keywords" value={draft} placeholder="Search Keywords" onChange={e => setDraft(e.target.value)} />
              </form>
              {filter ? <span className="kl-filter">Filter: {filter.name}<button aria-label="Clear Filters" onClick={() => setFilter(null)}>×</button></span> : null}
              <label className="kl-check"><input type="checkbox" checked={archived} onChange={e => { setArchived(e.target.checked); setSelected(null); }} />Archived</label>
              <span className="kl-note">Numbers are estimated per Google Ads standards, for judgment purposes only</span>
            </div>
            <KeywordTable key={identity} source={source} siteId={site.id} language={language}
              query={{ query: search, parent_id: filter?.id, archived }}
              selectedId={selected?.id || null} onSelect={setSelected} onFilter={applyFilter} />
          </> : null}
          {view === 'clusters' ? <ClusterView key={identity} source={source} siteId={site.id} language={language} archived={archived} onSelect={setSelected} onFilter={applyFilter} /> : null}
          {view === 'logs' ? <>
            <div className="kl-toolbar">
              <select aria-label="Operator" value={actor} onChange={e => setActor(e.target.value)}>
                <option value="">All Operators</option><option value="agent">AI</option><option value="human">by</option>
              </select>
            </div>
            <LibraryLogs key={identity} source={source} siteId={site.id} language={language} actor={actor} />
          </> : null}
        </div>
        {selected ? <KeywordPanel key={selected.id} source={source} siteId={site.id} ownDomain={site.root_domain || site.domain || ''} language={language} entry={selected}
          onClose={() => setSelected(null)} onFilter={applyFilter} /> : null}
      </div> : null}
    </div>
  </Shell>;
}
