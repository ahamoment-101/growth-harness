import type { LibraryEntryView, LibraryLanguage } from '../../shared/keyword-library';
import { priorityTone, text } from './format';
import { DifficultyCell, StatusPill, TrendCell, VolumeCell } from './SearchCells';
import type { EntryQuery, LibrarySource } from './source';
import { usePages } from './usePages';

export function KeywordTable({ source, siteId, language, query, selectedId, onSelect, onFilter }: {
  source: LibrarySource; siteId: string; language: LibraryLanguage; query: Omit<EntryQuery, 'kind' | 'after'>;
  selectedId: string | null; onSelect: (entry: LibraryEntryView) => void; onFilter: (parent: { id: string; name: string }) => void;
}) {
  const state = usePages<LibraryEntryView>(after => source.entries(siteId, language, { ...query, kind: 'keyword', after }));
  return <>
    <div className="kl-table-wrap">
      <table className="kl-table clickable">
        <thead><tr>
          <th className="kl-col-name">Keyword</th>
          <th className="num">Monthly search volume</th>
          <th className="num">Difficulty</th>
          <th className="kl-col-trend">12-month trend</th>
          <th>Priority</th>
          <th className="kl-col-cluster">Keyword cluster</th>
          <th className="num kl-col-topics">Topic Selection</th>
          <th className="kl-col-status">Data</th>
        </tr></thead>
        <tbody>{state.items.map(entry => {
          const clusters = entry.parents.filter(p => p.kind === 'cluster');
          return <tr key={entry.id} className={entry.id === selectedId ? 'selected' : ''} onClick={() => onSelect(entry)}>
            <td className="kl-col-name">
              <button className="kl-word" onClick={event => { event.stopPropagation(); onSelect(entry); }}>{entry.name}</button>
              <small>{text(entry.data.intents)}{Array.isArray(entry.data.scenarios) && entry.data.scenarios.length ? ` · ${text(entry.data.scenarios)}` : ''}</small>
            </td>
            <td className="num"><VolumeCell data={entry.search_data} /></td>
            <td className="num"><DifficultyCell data={entry.search_data} /></td>
            <td className="kl-col-trend"><TrendCell data={entry.search_data} /></td>
            <td><span className={`kl-priority ${priorityTone(entry.data.priority)}`}><i />{text(entry.data.priority)}</span></td>
            <td className="kl-col-cluster">{clusters.length ? clusters.map(c => <button key={c.id} className="kl-tag cluster" onClick={event => { event.stopPropagation(); onFilter(c); }}>{c.name}</button>) : <span className="kl-unknown">Unclustered</span>}</td>
            <td className="num kl-col-topics">{entry.topic_count || <span className="kl-unknown">0</span>}</td>
            <td className="kl-col-status"><StatusPill data={entry.search_data} /></td>
          </tr>;
        })}</tbody>
      </table>
      {!state.loading && !state.error && !state.items.length ? <div className="kl-empty"><h3>No matching keywords</h3><p>Try a different search term, or clear the filters.</p></div> : null}
    </div>
    <div className="kl-foot" aria-live="polite">
      {state.error ? <p className="kl-error" role="alert">{state.error} <button className="btn sm" onClick={state.retry}>Retry</button></p> : null}
      {state.loading ? 'Loading…' : state.next ? <button className="btn sm" onClick={state.more}>Load more</button> : state.items.length ? `${state.items.length} keywords in total` : null}
    </div>
  </>;
}
