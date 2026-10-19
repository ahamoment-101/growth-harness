import { useEffect, useState } from 'react';
import type { LibraryEntryView, LibraryLanguage } from '../../shared/keyword-library';
import { dataStatus, formatNumber, peakVolume, text } from './format';
import { DifficultyCell, StatusPill, VolumeCell } from './SearchCells';
import type { LibrarySource } from './source';
import { readAll, usePages } from './usePages';

type Loaded = { groups: LibraryEntryView[]; clusters: LibraryEntryView[]; truncated: boolean };

/** Topic groups with their clusters; each cluster shows how much of its demand is measured. */
export function ClusterView({ source, siteId, language, archived, onSelect, onFilter }: {
  source: LibrarySource; siteId: string; language: LibraryLanguage; archived: boolean;
  onSelect: (entry: LibraryEntryView) => void; onFilter: (parent: { id: string; name: string }) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    const list = (kind: LibraryEntryView['kind']) => readAll(after => source.entries(siteId, language, { kind, archived, after }));
    Promise.all([list('topic_group'), list('cluster')])
      .then(([groups, clusters]) => { if (live) setLoaded({ groups: groups.items, clusters: clusters.items, truncated: groups.truncated || clusters.truncated }); })
      .catch(cause => { if (live) setError((cause as Error).message); });
    return () => { live = false; };
  }, [source, siteId, language.locale, archived, attempt]);

  if (error) return <p className="kl-error" role="alert">{error} <button className="btn sm" onClick={() => setAttempt(n => n + 1)}>Retry</button></p>;
  if (!loaded) return <p className="kl-muted kl-pad">Reading keyword clusters…</p>;
  const sections = loaded.groups.map(group => ({ group, clusters: loaded.clusters.filter(c => c.parents.some(p => p.id === group.id)) }));
  const loose = loaded.clusters.filter(c => !c.parents.some(p => p.kind === 'topic_group'));
  if (!sections.length && !loose.length) return <div className="kl-empty"><h3>No topic groups or keyword clusters yet</h3><p>The Keyword Researcher Agent creates topic groups based on demand directions, then groups keywords that can be satisfied by the same page into keyword clusters.</p></div>;
  return <div className="kl-groups">
    {sections.map(({ group, clusters }) => <section key={group.id} className="kl-group">
      <header>
        <div><h3>{group.name}</h3><p>{text(group.data.description)}</p></div>
        <button className="btn sm" onClick={() => onFilter(group)}>{group.keyword_count} keywords →</button>
      </header>
      {clusters.length ? clusters.map(c => <ClusterRow key={c.id} source={source} siteId={siteId} language={language} cluster={c} onSelect={onSelect} onFilter={onFilter} />)
        : <p className="kl-muted kl-pad">No keyword clusters under this topic group yet.</p>}
    </section>)}
    {loose.length ? <section className="kl-group">
      <header><div><h3>Not assigned to a topic group</h3></div></header>
      {loose.map(c => <ClusterRow key={c.id} source={source} siteId={siteId} language={language} cluster={c} onSelect={onSelect} onFilter={onFilter} />)}
    </section> : null}
    {loaded.truncated ? <p className="kl-muted">There are many keyword clusters; only the first portion is shown.</p> : null}
  </div>;
}

function ClusterRow({ source, siteId, language, cluster, onSelect, onFilter }: {
  source: LibrarySource; siteId: string; language: LibraryLanguage; cluster: LibraryEntryView;
  onSelect: (entry: LibraryEntryView) => void; onFilter: (parent: { id: string; name: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const keywords = usePages<LibraryEntryView>(after => source.entries(siteId, language, { kind: 'keyword', parent_id: cluster.id, after }));
  const measured = keywords.items.filter(k => dataStatus(k.search_data).kind === 'measured');
  const total = measured.reduce((sum, k) => sum + (peakVolume(k.search_data) || 0), 0);
  const partial = Boolean(keywords.next);
  return <article className={`kl-cluster${open ? ' open' : ''}`}>
    <button className="kl-cluster-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span className="kl-caret" aria-hidden="true">›</span>
      <span className="kl-cluster-name"><strong>{cluster.name}</strong><small>{text(cluster.data.need)}</small></span>
      <span className="kl-cluster-demand" title="Sum of each keyword's monthly search volume in the top countries; overlapping audiences for near-synonyms make totals overestimated">
        {keywords.loading && !keywords.items.length ? '…' : measured.length ? <><strong>approx. {formatNumber(total)}{partial ? '+' : ''}</strong><small>/month · combined estimate</small></> : <small>No search data</small>}
      </span>
      <span className="kl-cluster-count">{measured.length}/{cluster.keyword_count} Has data</span>
    </button>
    {open ? <div className="kl-cluster-body">
      {cluster.data.rationale ? <p className="kl-muted">Grouping rationale:{text(cluster.data.rationale)}</p> : null}
      <ul>{keywords.items.map(k => <li key={k.id}>
        <button className="kl-word" onClick={() => onSelect(k)}>{k.name}</button>
        <VolumeCell data={k.search_data} /><DifficultyCell data={k.search_data} /><StatusPill data={k.search_data} />
      </li>)}</ul>
      {keywords.error ? <p className="kl-error" role="alert">{keywords.error} <button className="btn sm" onClick={keywords.retry}>Retry</button></p> : null}
      <div className="kl-cluster-actions">
        {keywords.next ? <button className="btn sm" onClick={keywords.more}>Load more</button> : null}
        <button className="btn sm quiet" onClick={() => onFilter(cluster)}>View in keyword table</button>
      </div>
    </div> : null}
  </article>;
}
