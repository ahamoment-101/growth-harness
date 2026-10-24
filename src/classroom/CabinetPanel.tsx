import { BusinessExperience } from './BusinessExperience';
import { useEffect, useState } from 'react';
import { api, type Site } from '../api';
import { BUSINESS_MODULES, type BusinessModuleKey } from '../../shared/business';
import { BusinessDrawer } from '../components/BusinessDrawer';
import { CabinetDocumentDetail, CabinetFileList } from './CabinetDocument';
import { strategyDocumentBody, type CabinetDocument as DocumentItem } from '../../shared/cabinet-document';
import './panels.css';

const categories = ['Business Profile', 'Strategy documents', 'Research materials', 'Business Experience'] as const;

/** The three shelves share one document list and detail view. */
export function CabinetPanel({ site, initialCategory = 'Business Profile', initialModule }: { site: Site; initialCategory?: string; initialModule?: BusinessModuleKey }) {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [category, setCategory] = useState(new URLSearchParams(location.search).get('category') === 'experience' ? 'Business Experience' : initialCategory);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(initialModule ? `business:${initialModule}` : null);
  const [editing, setEditing] = useState<BusinessModuleKey | null>(null);
  const locales = [...new Set([site.source_locale, ...site.translate_locales].filter(Boolean))].sort().join('|');

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErrors([]);
    async function load() {
      const collections = await Promise.allSettled([
        api.business(site.id).then(({ modules }): DocumentItem[] => BUSINESS_MODULES.map((definition) => {
          const module = modules.find((item) => item.key === definition.key);
          return { id: `business:${definition.key}`, title: definition.label, category: 'Business Profile', locale: 'Project shared', version: module?.version ?? 0, body: module?.markdown ?? '', date: module?.updated_at ?? '' };
        })),
        ...locales.split('|').filter(Boolean).map((locale) => api.research(site.id, locale).then((state): DocumentItem[] => {
          const strategy = strategyDocumentBody(state.documents.strategy?.body ?? '', state.documents.research_notes?.body ?? '');
          const keywordMap = state.documents.keyword_map;
          return [
            ...(strategy ? [{ id: `${locale}:strategy`, title: 'SEO strategy', category: 'Strategy documents', locale, version: state.strategy?.version ?? 0, body: strategy, date: state.documents.strategy?.created_at || state.documents.research_notes?.created_at || '' }] : []),
            ...(keywordMap?.body.trim() ? [{ id: `${locale}:keyword_map`, title: 'Keyword research document', category: 'Research materials', locale, version: state.strategy?.version ?? 0, body: keywordMap.body, date: keywordMap.created_at }] : []),
          ];
        })),
      ]);
      if (!live) return;
      const names = ['Business Profile', ...locales.split('|').filter(Boolean)];
      setDocuments((previous) => collections.flatMap((result, index) => result.status === 'fulfilled'
        ? result.value
        : previous.filter((doc) => index === 0 ? doc.category === 'Business Profile' : doc.locale === names[index])));
      setErrors(collections.flatMap((result, index) => result.status === 'rejected' ? [`${names[index]} Failed to read: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []));
      setLoading(false);
    }
    void load();
    return () => { live = false; };
  }, [site.id, locales, reload]);

  const filtered = documents.filter((doc) => doc.category === category && `${doc.title} ${doc.locale}`.toLowerCase().includes(query.toLowerCase()));
  const selected = documents.find((doc) => doc.id === selectedId);
  const selectedModule = selected?.category === 'Business Profile' ? selected.id.slice('business:'.length) as BusinessModuleKey : null;

  return <section className="room-panel cabinet-panel">
    <header className="room-panel-heading"><div><span className="room-eyebrow">Classroom · File Cabinet</span><h1>Materials left by the team</h1><p>Research and judgment are kept together for easy reference whenever needed.</p></div><span className="room-preview-label live">Real materials</span></header>
    {selected ? <>
      <button type="button" className="room-back" onClick={() => setSelectedId(null)}>← Back{category}</button>
      <CabinetDocumentDetail document={selected}>
        {selectedModule ? <button type="button" className="room-back" onClick={() => setEditing(selectedModule)}>Edit business profile</button> : null}
      </CabinetDocumentDetail>
    </> : <>
      <div className="room-activity-tools"><div className="room-filter-row" aria-label="Material categories">{categories.map((value) => <button type="button" aria-pressed={category === value} key={value} onClick={() => { setCategory(value); setSelectedId(null); const url = new URL(location.href); url.searchParams.delete('experience'); if (value === 'Business Experience') url.searchParams.set('category', 'experience'); else url.searchParams.delete('category'); history.replaceState(null, '', url); }}>{value}</button>)}</div>{category !== 'Business Experience' && <input type="search" aria-label="Search materials" placeholder="Search by name or language…" value={query} onChange={(event) => setQuery(event.target.value)} />}</div>
      {category === 'Business Experience' ? <BusinessExperience siteId={site.id} /> : loading ? <p className="room-empty" role="status">Opening the file cabinet…</p> : <>
        {errors.length ? <div className="room-read-error" role="alert">{errors.map((error) => <p key={error}>{error}</p>)}<button type="button" onClick={() => setReload((value) => value + 1)}>Re-read</button></div> : null}
        <CabinetFileList documents={filtered} onOpen={setSelectedId} />
        {!filtered.length ? <p className="room-empty">{query ? 'No matching materials. Try other criteria.' : errors.length ? 'Some materials could not be read. Please retry.' : 'This category has no materials yet.'}</p> : null}
      </>}
    </>}
    {editing ? <BusinessDrawer site={site} moduleKey={editing} onClose={() => { setEditing(null); setReload((value) => value + 1); }} /> : null}
  </section>;
}
