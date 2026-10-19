import { useState } from 'react';
import type { KeywordCountryMetrics, KeywordSearchData, LibraryDetail, LibraryEntryView, LibraryLanguage } from '../../shared/keyword-library';
import { Link } from '../nav';
import {
  countryName, dataStatus, difficultyBand, featureLabel, formatCpc, formatNumber, intentLabel, priorityTone, shortDate, text,
} from './format';
import { LibraryLogs } from './LibraryLogs';
import type { LibrarySource } from './source';
import { topicHref } from './links';
import { usePages } from './usePages';

type Evidence = { source?: string; observation?: string; observed_at?: string; url?: string };
type Metric = { name?: string; value?: number | null; unit?: string; source?: string; period?: string; scope?: string; observed_at?: string };

export function KeywordPanel({ source, siteId, ownDomain, language, entry, onClose, onFilter }: {
  source: LibrarySource; siteId: string; ownDomain: string; language: LibraryLanguage; entry: LibraryEntryView;
  onClose: () => void; onFilter: (parent: { id: string; name: string }) => void;
}) {
  const data = entry.data;
  const evidence = Array.isArray(data.evidence) ? data.evidence as Evidence[] : [];
  const agentMetrics = Array.isArray(data.metrics) ? data.metrics as Metric[] : [];
  const uncertainties = Array.isArray(data.uncertainties) ? data.uncertainties as string[] : [];
  return <aside className="kl-panel" aria-label={`${entry.name} Details`}>
    <header className="kl-panel-head">
      <div>
        <h2>{entry.name}</h2>
        <div className="kl-panel-tags">
          {entry.parents.map(p => <button key={p.id} className={`kl-tag ${p.kind === 'cluster' ? 'cluster' : ''}`} onClick={() => onFilter(p)} title="Filter in the keyword library">{p.name}</button>)}
          {entry.archived ? <span className="kl-pill neutral">Archived</span> : null}
        </div>
      </div>
      <button className="kl-icon-btn" aria-label="Close details" onClick={onClose}>×</button>
    </header>

    <section className="kl-section">
      <div className="kl-section-head"><h3>Search data</h3><span>Queried by the system, not filled in by AI</span></div>
      <SearchData data={entry.search_data} ownDomain={ownDomain} />
    </section>

    <section className="kl-section">
      <div className="kl-section-head"><h3>AI's research judgment</h3><span>Written by the Keyword Researcher agent</span></div>
      <div className="kl-judgment">
        <div className="kl-priority-line"><span className={`kl-priority ${priorityTone(data.priority)}`}><i />{text(data.priority)}</span><p>{text(data.priority_reason)}</p></div>
        <dl className="kl-fields">
          <div><dt>Business relationship</dt><dd>{text(data.business_relevance)}</dd></div>
          <div><dt>Search intent</dt><dd>{text(data.intents)}</dd></div>
          <div><dt>User stage</dt><dd>{text(data.stages)}</dd></div>
          <div><dt>Target audience</dt><dd>{text(data.audiences)}</dd></div>
          <div><dt>Use case</dt><dd>{text(data.scenarios)}</dd></div>
          <div><dt>Suggested format</dt><dd>{text(data.suggested_formats)}</dd></div>
        </dl>
        {uncertainties.length ? <div className="kl-uncertain"><h4>Uncertain</h4><ul>{uncertainties.map(u => <li key={u}>{u}</li>)}</ul></div> : null}
        {evidence.length ? <div className="kl-evidence"><h4>Research evidence <span>{evidence.length}</span></h4>{evidence.map((e, i) => <article key={i}>
          <small>{e.source || 'No source noted'}{e.observed_at ? ` · Recorded by AI ${shortDate(e.observed_at)}` : ''}</small>
          <p>{e.observation}</p>
          {e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.url.replace(/^https?:\/\//, '')} ↗</a> : null}
        </article>)}</div> : null}
        {agentMetrics.length ? <div className="kl-evidence"><h4>Metrics recorded by AI</h4>{agentMetrics.map((m, i) => <article key={i}>
          <small>{m.source} · {m.period} · {m.scope}</small><p>{m.name}: {m.value ?? 'Unknown'} {m.unit}</p>
        </article>)}</div> : null}
      </div>
    </section>

    <Topics key={`${entry.id}-topics`} source={source} siteId={siteId} language={language} entryId={entry.id} />

    <details className="kl-section kl-history">
      <summary><h3>Change history</h3><span>Version {entry.revision}</span></summary>
      <LibraryLogs key={entry.id} source={source} siteId={siteId} language={language} actor="" target={entry.id} compact />
    </details>
  </aside>;
}

function SearchData({ data, ownDomain }: { data?: KeywordSearchData | null; ownDomain: string }) {
  const status = dataStatus(data);
  const rows = data?.metrics || [];
  const [country, setCountry] = useState(() => [...rows].sort((a, b) => (b.search_volume ?? -1) - (a.search_volume ?? -1))[0]?.country || '');
  if (status.kind === 'not_checked') return <p className="kl-empty-note">Not queried yet. After the Keyword Researcher agent runs a query, search volume, difficulty, trend, and SERP data will appear here.</p>;
  const row = rows.find(r => r.country === country) || rows[0];
  const serp = data?.serp.find(s => s.country === row.country) || null;
  return <>
    {rows.length > 1 ? <div className="kl-countries" role="tablist" aria-label="Country">{rows.map(r => <button key={r.country} role="tab" aria-selected={r.country === row.country} className={r.country === row.country ? 'on' : ''} onClick={() => setCountry(r.country)}>{countryName(r.country)}</button>)}</div> : null}
    {row.search_volume === null
      ? <p className="kl-empty-note">{shortDate(row.observed_at)} Queried{countryName(row.country)}: The data source has no data for this keyword, which usually means search volume is very small — it does not mean nobody searches for it.</p>
      : <Metrics row={row} />}
    {serp ? <div className="kl-serp">
      <h4>Search results page (SERP) <span>{countryName(serp.country)} · Top  {serp.results.length}  results · {shortDate(serp.observed_at)}</span></h4>
      {serp.features.length ? <div className="kl-features">{serp.features.map(f => <span key={f} className="kl-tag">{featureLabel(f)}</span>)}</div> : null}
      <ol>{serp.results.map(r => {
        const own = ownDomain && (r.domain === ownDomain || r.domain.endsWith(`.${ownDomain}`));
        return <li key={r.rank} className={own ? 'own' : ''}><span className="kl-rank">{r.rank}</span><div><strong>{r.domain}{own ? <em>Us</em> : null}</strong><small>{r.title}</small></div></li>;
      })}</ol>
      <p className="kl-source">Only organic results are counted; {serp.source}</p>
    </div> : <p className="kl-empty-note">The SERP for this keyword has not been viewed yet.</p>}
  </>;
}

function Metrics({ row }: { row: KeywordCountryMetrics }) {
  const band = difficultyBand(row.keyword_difficulty);
  const volumes = row.monthly.map(m => m.volume ?? 0);
  const max = Math.max(1, ...volumes);
  return <>
    <div className="kl-kpis">
      <div><span>Monthly search volume</span><strong>{formatNumber(row.search_volume!)}</strong></div>
      <div><span>Difficulty</span><strong className={band ? `kl-kd ${band.tone}` : ''}>{row.keyword_difficulty ?? '—'}<small>{band ? ` / 100 · ${band.label}` : ''}</small></strong></div>
      <div><span>Intent</span><strong className="small">{intentLabel(row.intent)}</strong></div>
      <div><span>CPC</span><strong className="small">{formatCpc(row.cpc_usd)}</strong></div>
    </div>
    {row.monthly.length ? <div className="kl-months" aria-label="Search volume, last 12 months">
      <div className="kl-bars">{row.monthly.map(m => <i key={m.month} style={{ height: `${Math.max(4, ((m.volume ?? 0) / max) * 100)}%` }} title={`${m.month}: ${m.volume === null ? 'No data' : formatNumber(m.volume)}`} />)}</div>
      <div className="kl-bar-axis"><span>{row.monthly[0].month}</span><span>{row.monthly[row.monthly.length - 1].month}</span></div>
    </div> : null}
    <p className="kl-source">{row.source} · {shortDate(row.observed_at)} Query · Monthly average estimated per Google Ads methodology; difficulty is the vendor's estimate</p>
  </>;
}

function Topics({ source, siteId, language, entryId }: { source: LibrarySource; siteId: string; language: LibraryLanguage; entryId: string }) {
  const state = usePages<LibraryDetail['topics'][number]>(async after => {
    const r = await source.detail(siteId, language, entryId, after);
    return { items: r.topics, next: r.topic_next };
  });
  return <section className="kl-section">
    <div className="kl-section-head"><h3>Linked topics</h3><span>{state.loading ? 'Loading…' : `${state.items.length}${state.next ? '+' : ''} items`}</span></div>
    {state.error ? <p className="kl-error" role="alert">{state.error} <button className="btn sm" onClick={state.retry}>Retry</button></p> : null}
    {state.items.map(t => <Link key={t.topic_id} className="kl-topic-link" to={topicHref(siteId, language, t.topic_id)}>
      <strong>{t.title_hint}</strong><small>{t.status} · {t.relationship}</small>
    </Link>)}
    {!state.loading && !state.error && !state.items.length ? <p className="kl-empty-note">No topics use this keyword yet.</p> : null}
    {state.next ? <button className="btn sm" disabled={state.loading} onClick={state.more}>Load more</button> : null}
  </section>;
}
