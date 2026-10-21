import { attendedPoll } from '../lib-polling';
import { useEffect, useRef, useState } from 'react';
import { api, formatDate, siteArticleHref, type Job, type Site } from '../api';
import { Shell } from '../components/Shell';
import { useEscapeDismiss } from '../components/escapeDismiss';
import { I, Link, contentArticlePage, sitePage } from '../nav';

type Row = { job: Job; locale: string; slug: string; title: string; excerpt: string };
type VisFilter = 'all' | 'visible' | 'hidden';

export default function ContentList({ site, sites }: { site: Site; sites: Site[] }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [err, setErr] = useState('');
  const [locale, setLocale] = useState('');
  const [visFilter, setVisFilter] = useState<VisFilter>('all');
  const [busyId, setBusyId] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importErr, setImportErr] = useState('');
  const [importLocale, setImportLocale] = useState('');
  const [importCategory, setImportCategory] = useState('');
  const [importTitle, setImportTitle] = useState('');
  const [importSlug, setImportSlug] = useState('');
  const [importExcerpt, setImportExcerpt] = useState('');
  const [importContent, setImportContent] = useState('');
  const importDialog = useRef<HTMLDivElement>(null);

  async function load() {
    const d = await api.jobs(site.id, 'published');
    setJobs(d.jobs);
  }

  async function toggleVisibility(jobId: string, current: Job['visibility']) {
    if (busyId) return;
    setBusyId(jobId);
    setErr('');
    try {
      const next = current === 'hidden' ? 'visible' : 'hidden';
      const d = await api.setJobVisibility(jobId, next);
      setJobs((prev) => (prev ? prev.map((j) => (j.id === jobId ? d.job : j)) : prev));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId('');
    }
  }

  async function localize(jobId: string) {
    if (busyId) return;
    setBusyId(jobId);
    setErr('');
    try {
      const d = await api.localizeJob(jobId);
      setJobs((prev) => (prev ? prev.map((j) => (j.id === jobId ? d.job : j)) : prev));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId('');
    }
  }

  async function removeLocale(job: Job, code: string) {
    if (busyId) return;
    if (!window.confirm(`Are you sure you want to take down the ${localeLabel(code)} version of this article? The live page for that language will be removed immediately.`)) return;
    setBusyId(job.id);
    setErr('');
    try {
      const d = await api.removeJobLocale(job.id, code);
      setJobs((prev) => (prev ? prev.map((j) => (j.id === job.id ? d.job : j)) : prev));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId('');
    }
  }

  const localizing = (jobs || []).some((job) => job.localization?.items.some((item) => item.status === 'running'));
  useEffect(() => {
    if (!localizing) return;
    const timer = window.setInterval(attendedPoll(() => {
      load().catch(() => { /* next tick retries */ });
    }), 15_000);
    return () => window.clearInterval(timer);
  }, [localizing, site.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setErr('');
    setJobs(null);
    setLocale('');
    setVisFilter('all');
    setShowImport(false);
    load().catch((e: Error) => setErr(e.message));
  }, [site.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!jobs) return;
    const codes = presentLocales(jobs);
    if (codes.length && !codes.includes(locale)) setLocale(codes[0]);
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  const importLocaleOptions = Array.from(
    new Set([site.source_locale || 'en', ...(site.locale_policy?.locales || []).map((l) => l.code), ...(site.locales || [])]),
  ).filter(Boolean);

  function openImport() {
    setImportErr('');
    setImportCategory('');
    setImportTitle('');
    setImportSlug('');
    setImportExcerpt('');
    setImportContent('');
    setImportLocale((prev) => prev || importLocaleOptions[0] || 'en');
    setShowImport(true);
  }

  function closeImport() {
    if (importBusy) return;
    setShowImport(false);
  }
  useEscapeDismiss(showImport, importDialog, closeImport);

  async function submitImport() {
    if (importBusy || !importLocale || !importTitle || !importSlug || !importContent) return;
    setImportBusy(true);
    setImportErr('');
    try {
      await api.importJob(site.id, {
        locale: importLocale,
        title: importTitle,
        slug: importSlug,
        excerpt: importExcerpt,
        content: importContent,
        category: importCategory,
      });
      setShowImport(false);
      await load();
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e));
    } finally {
      setImportBusy(false);
    }
  }

  const locales = jobs ? presentLocales(jobs) : [];
  const localeRows: Row[] = (jobs || []).flatMap((job) => {
    const version = job.versions?.find((v) => v.locale === locale);
    return version ? [{ job, locale, slug: version.slug, title: version.title, excerpt: version.excerpt }] : [];
  });
  const visibleCount = localeRows.filter((row) => row.job.visibility !== 'hidden').length;
  const hiddenCount = localeRows.filter((row) => row.job.visibility === 'hidden').length;
  const rows = localeRows.filter((row) => {
    if (visFilter === 'all') return true;
    return visFilter === 'hidden' ? row.job.visibility === 'hidden' : row.job.visibility !== 'hidden';
  });

  return (
    <Shell
      sites={sites}
      site={site}
      active="content-list"
      crumb={
        <>
          <Link className="muted" to={sitePage(site.id)}>Main screen</Link>
          <span className="sep">›</span>
          <span className="muted">GrowthHarness</span>
          <span className="sep">›</span>
          <span className="cur">Content List</span>
        </>
      }
    >
      <div className="content-list-page">
        <section className="content-list-head">
          <div className="content-list-title-row">
            <div>
              <p className="team-eyebrow">CONTENT LIBRARY</p>
              <h1>Content List</h1>
            </div>
            <button className="btn primary" type="button" onClick={openImport}>
              {I.plus}
              Import content
            </button>
          </div>
          <p className="content-list-lead">
            For approved and published articles, the display order matches the blog list on the  {site.root_domain || site.domain || 'blog site'}  and is organized by language.
          </p>
        </section>

        {err ? <p className="flash">{err}</p> : null}

        {jobs === null ? (
          <p className="empty">Loading…</p>
        ) : locales.length === 0 ? (
          <div className="content-list-empty">
            <p>No published articles yet. They will appear here once approved and published.</p>
          </div>
        ) : (
          <>
            <div className="content-list-controls">
              <nav className="subtabs">
                {locales.map((code) => (
                  <button
                    key={code}
                    type="button"
                    className={`tab${locale === code ? ' active' : ''}`}
                    onClick={() => setLocale(code)}
                  >
                    {localeLabel(code)}
                    <span className="n">{countFor(jobs, code)}</span>
                  </button>
                ))}
              </nav>
              <div className="content-list-filter" role="group" aria-label="Display status filter">
                <button
                  type="button"
                  className={`seg-btn${visFilter === 'all' ? ' active' : ''}`}
                  onClick={() => setVisFilter('all')}
                >
                  All<span className="n">{localeRows.length}</span>
                </button>
                <button
                  type="button"
                  className={`seg-btn${visFilter === 'visible' ? ' active' : ''}`}
                  onClick={() => setVisFilter('visible')}
                >
                  Shown only<span className="n">{visibleCount}</span>
                </button>
                <button
                  type="button"
                  className={`seg-btn${visFilter === 'hidden' ? ' active' : ''}`}
                  onClick={() => setVisFilter('hidden')}
                >
                  Hidden only<span className="n">{hiddenCount}</span>
                </button>
              </div>
            </div>
            {rows.length === 0 ? (
              <div className="content-list-empty">
                <p>No articles under the current filter.</p>
              </div>
            ) : null}
            <div className="content-list-grid">
              {rows.map((row) => (
                <Link
                  key={row.job.id}
                  className={`content-card${row.job.visibility === 'hidden' ? ' hidden-article' : ''}`}
                  to={contentArticlePage(site.id, row.job.id, row.locale)}
                >
                  <div className="content-card-top">
                    <span className="content-card-tags">
                      {row.job.category ? <span className="content-card-tag">{categoryLabel(row.job.category)}</span> : null}
                      {row.job.visibility === 'hidden' ? <span className="content-card-tag muted">Hidden</span> : null}
                    </span>
                    <span className="content-card-date">{formatDate(row.job.published_at || row.job.created_at)}</span>
                  </div>
                  <h3 className="content-card-title">{row.title}</h3>
                  {row.excerpt ? <p className="content-card-excerpt">{row.excerpt}</p> : null}
                  <LocalizationStatus job={row.job} />
                  <div className="content-card-actions">
                    <button
                      type="button"
                      className="content-card-live"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        window.open(siteArticleHref(site, row.locale, row.slug), '_blank', 'noopener,noreferrer');
                      }}
                    >
                      {I.external}
                      View live version
                    </button>
                    <span className="content-card-ops">
                      {row.job.localization?.missing_locales.length ? (
                        <button
                          type="button"
                          className="content-card-toggle"
                          disabled={busyId === row.job.id}
                          title={`Localize into: ${row.job.localization.missing_locales.map(localeLabel).join(', ')}, then go live directly when done`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            localize(row.job.id);
                          }}
                        >
                          Fill in other languages
                        </button>
                      ) : null}
                      {row.locale !== sourceLocaleOf(row.job) ? (
                        <button
                          type="button"
                          className="content-card-toggle"
                          disabled={busyId === row.job.id}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            removeLocale(row.job, row.locale);
                          }}
                        >
                          Take down this language
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="content-card-toggle"
                        disabled={busyId === row.job.id}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleVisibility(row.job.id, row.job.visibility);
                        }}
                      >
                        {row.job.visibility === 'hidden' ? 'Set to show' : 'Set to hidden'}
                      </button>
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}

        {showImport ? (
          <div className="modal-overlay" onClick={closeImport}>
            <div
              ref={importDialog}
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-label="Import content"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-head">
                <h2>Import content</h2>
                <button className="modal-close" type="button" aria-label="Close" onClick={closeImport}>
                  ×
                </button>
              </div>
              <p className="modal-lead">
                Manually add a published article; after saving it will appear immediately in the content list and on the site blog.
              </p>
              {importErr ? <p className="flash">{importErr}</p> : null}
              <div className="field">
                <label className="label" htmlFor="import-locale">
                  Language
                </label>
                <select
                  id="import-locale"
                  className="input"
                  value={importLocale}
                  onChange={(e) => setImportLocale(e.target.value)}
                >
                  {importLocaleOptions.map((code) => (
                    <option key={code} value={code}>
                      {localeLabel(code)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="import-category">
                  Category (optional)
                </label>
                <input
                  id="import-category"
                  className="input"
                  value={importCategory}
                  onChange={(e) => setImportCategory(e.target.value)}
                  placeholder="e.g. METHOD"
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="import-title">
                  Title
                </label>
                <input
                  id="import-title"
                  className="input"
                  value={importTitle}
                  onChange={(e) => setImportTitle(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="import-slug">
                  Slug
                </label>
                <input
                  id="import-slug"
                  className="input mono"
                  value={importSlug}
                  onChange={(e) => setImportSlug(e.target.value)}
                  placeholder="lowercase-kebab-case"
                />
                <p className="field-hint">Lowercase letters, numbers, and hyphens; must not duplicate a published article in the same language.</p>
              </div>
              <div className="field">
                <label className="label" htmlFor="import-excerpt">
                  Excerpt (optional)
                </label>
                <textarea
                  id="import-excerpt"
                  className="textarea content-edit-excerpt"
                  value={importExcerpt}
                  onChange={(e) => setImportExcerpt(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="import-content">
                  Body (Markdown)
                </label>
                <textarea
                  id="import-content"
                  className="textarea content-edit-body"
                  value={importContent}
                  onChange={(e) => setImportContent(e.target.value)}
                />
              </div>
              <div className="modal-actions">
                <button className="btn" type="button" onClick={closeImport} disabled={importBusy}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  type="button"
                  onClick={submitImport}
                  disabled={importBusy || !importLocale || !importTitle || !importSlug || !importContent}
                >
                  {importBusy ? 'Importing…' : 'Import'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

function LocalizationStatus({ job }: { job: Job }) {
  const items = job.localization?.items || [];
  if (!items.length) return null;
  const running = items.filter((item) => item.status === 'running');
  const failed = items.filter((item) => item.status === 'failed');
  return (
    <div className="content-card-localize">
      {running.length ? <span>Localizing: {running.map((item) => localeLabel(item.locale)).join(', ')}</span> : null}
      {failed.map((item) => (
        <span key={item.locale} className="failed" title={item.error}>
          {localeLabel(item.locale)}Localization failed{item.error ? `: ${item.error}` : ''}
        </span>
      ))}
    </div>
  );
}

/** The language the article was written and approved in; other languages are localized from it. */
function sourceLocaleOf(job: Job): string {
  return job.source_locale || job.versions?.[0]?.locale || '';
}

/** Locales in first-appearance order among published jobs (already sorted newest-first) — matches the blog's own language switcher. */
function presentLocales(jobs: Job[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const job of jobs) {
    for (const version of job.versions || []) {
      if (seen.has(version.locale)) continue;
      seen.add(version.locale);
      out.push(version.locale);
    }
  }
  return out;
}

function countFor(jobs: Job[], locale: string): number {
  return jobs.reduce((n, job) => n + (job.versions?.some((v) => v.locale === locale) ? 1 : 0), 0);
}

/** "METHOD" -> "Method" — mirrors worker/blog/render.ts categoryLabel so tags match the live site. */
function categoryLabel(category: string): string {
  return category
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function localeLabel(code: string): string {
  try {
    const locale = new Intl.Locale(code);
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    const language = names.of(locale.language) || code;
    if (!locale.region) return language;
    const regions = new Intl.DisplayNames(['en'], { type: 'region' });
    return `${language} (${regions.of(locale.region) || locale.region})`;
  } catch {
    return code;
  }
}
