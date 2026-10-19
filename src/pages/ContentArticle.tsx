import { useEffect, useState } from 'react';
import { api, siteArticleHref, type ArticleVersion, type Job, type Site } from '../api';
import { Shell } from '../components/Shell';
import { I, Link, sitePage } from '../nav';

export default function ContentArticle({ site, sites, jobId }: { site: Site; sites: Site[]; jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [visBusy, setVisBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [locale, setLocale] = useState('');
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [metaDescription, setMetaDescription] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [imageAlt, setImageAlt] = useState('');
  const [content, setContent] = useState('');

  function applyLocale(versions: ArticleVersion[], code: string) {
    const version = versions.find((v) => v.locale === code);
    setLocale(code);
    setTitle(version?.title || '');
    setSlug(version?.slug || '');
    setExcerpt(version?.excerpt || '');
    setContent(version?.content || '');
    setMetaDescription(version?.meta_description || '');
    setImageUrl(version?.image_url || '');
    setImageAlt(version?.image_alt || '');
    setDirty(false);
  }

  async function load() {
    const d = await api.job(jobId);
    setJob(d.job);
    setCategory(d.job.category || '');
    const versions = d.job.versions || [];
    const requested = new URLSearchParams(window.location.search).get('locale') || '';
    const startLocale = versions.some((v) => v.locale === requested) ? requested : versions[0]?.locale || '';
    applyLocale(versions, startLocale);
  }

  useEffect(() => {
    setErr('');
    setMsg('');
    setJob(null);
    load().catch((e: Error) => setErr(e.message));
  }, [jobId]);

  function switchLocale(code: string) {
    if (code === locale) return;
    if (dirty && !window.confirm('The current language has unsaved changes; switching will lose them. Continue?')) return;
    applyLocale(job?.versions || [], code);
    setMsg('');
  }

  function markDirty<T extends (value: string) => void>(setter: T) {
    return (value: string) => {
      setter(value);
      setDirty(true);
      setMsg('');
    };
  }

  const setTitleDirty = markDirty(setTitle);
  const setSlugDirty = markDirty(setSlug);
  const setExcerptDirty = markDirty(setExcerpt);
  const setContentDirty = markDirty(setContent);
  const setCategoryDirty = markDirty(setCategory);

  async function save() {
    if (!locale) return;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const d = await api.updateJobContent(jobId, { locale, title, slug, excerpt, content, category, meta_description: metaDescription, image_url: imageUrl, image_alt: imageAlt });
      setJob(d.job);
      setDirty(false);
      setMsg('Saved');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleVisibility() {
    if (!job) return;
    const next = job.visibility === 'hidden' ? 'visible' : 'hidden';
    setVisBusy(true);
    setErr('');
    setMsg('');
    try {
      const d = await api.setJobVisibility(jobId, next);
      setJob(d.job);
      setMsg(next === 'hidden' ? 'Set to hidden' : 'Set to visible');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setVisBusy(false);
    }
  }

  const versions = job?.versions || [];
  const heading = title || job?.title || 'Edit article';

  return (
    <Shell
      sites={sites}
      site={site}
      active="content-article"
      crumb={
        <>
          <Link className="muted" to={sitePage(site.id, 'content-list')}>
            {I.back}
          </Link>
          <Link className="muted" to={sitePage(site.id, 'content-list')}>
            Content List
          </Link>
          <span className="sep">›</span>
          <span className="cur">{heading}</span>
        </>
      }
      actions={
        <>
          {job?.status === 'published' && locale && slug ? (
            <a className="btn" href={siteArticleHref(site, locale, slug)} target="_blank" rel="noopener noreferrer">
              {I.external}
              View live version
            </a>
          ) : null}
          <button className="btn primary" type="button" onClick={save} disabled={busy || !job || !title || !slug || !content}>
            Save
          </button>
        </>
      }
      tabs={
        versions.length > 1 ? (
          <>
            {versions.map((v) => (
              <button
                key={v.locale}
                type="button"
                className={`tab${locale === v.locale ? ' active' : ''}`}
                onClick={() => switchLocale(v.locale)}
              >
                {v.locale}
              </button>
            ))}
          </>
        ) : undefined
      }
    >
      {!job ? <p className="empty">{err || 'Loading…'}</p> : null}
      {job ? (
        <div className="content-edit">
          {err ? <p className="flash">{err}</p> : null}
          {msg ? <p className="okmsg">{msg}</p> : null}
          <div className="strip">
            <div className="field">
              <span className="label">Status</span>
              <span className="state-text">
                {job.status === 'published' ? I.check : I.wait}
                {job.status}
              </span>
            </div>
            <div className="field">
              <span className="label">Visibility status</span>
              <span className={`pill ${job.visibility === 'hidden' ? 'warn' : 'ok'}`}>
                <span className="pdot" />
                {job.visibility === 'hidden' ? 'Hidden' : 'Showing'}
              </span>
            </div>
            {job.status === 'published' ? (
              <button className="btn sm" type="button" onClick={toggleVisibility} disabled={visBusy}>
                {job.visibility === 'hidden' ? 'Set to show' : 'Set to hidden'}
              </button>
            ) : null}
            <div className="field grow">
              <label className="label" htmlFor="article-category">
                Category
              </label>
              <input
                id="article-category"
                className="input"
                value={category}
                onChange={(e) => setCategoryDirty(e.target.value)}
                placeholder="e.g. METHOD"
              />
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="article-title">
              Title
            </label>
            <input id="article-title" className="input" value={title} onChange={(e) => setTitleDirty(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="article-slug">
              Slug
            </label>
            <input
              id="article-slug"
              className="input mono"
              value={slug}
              onChange={(e) => setSlugDirty(e.target.value)}
              placeholder="lowercase-kebab-case"
            />
            <p className="field-hint">Lowercase letters, numbers, and hyphens; after a change, the old URL will automatically redirect to the new one.</p>
          </div>
          <div className="field">
            <label className="label" htmlFor="article-excerpt">
              Summary
            </label>
            <textarea
              id="article-excerpt"
              className="textarea content-edit-excerpt"
              value={excerpt}
              onChange={(e) => setExcerptDirty(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="article-meta-description">Search and share description</label>
            <textarea id="article-meta-description" className="textarea" value={metaDescription} onChange={(e) => markDirty(setMetaDescription)(e.target.value)} />
            <p className="field-hint">Briefly explain what readers will get from the article. When left empty, the first paragraph of the summary is used.</p>
          </div>
          <div className="field">
            <label className="label" htmlFor="article-image">Article cover image URL</label>
            <input id="article-image" className="input" type="url" value={imageUrl} onChange={(e) => markDirty(setImageUrl)(e.target.value)} placeholder="https://…" />
            <p className="field-hint">Use a real, publicly accessible image. When no cover is set, the share image falls back to the first image in the body, then to the site default image.</p>
          </div>
          <div className="field">
            <label className="label" htmlFor="article-image-alt">Cover image description</label>
            <input id="article-image-alt" className="input" value={imageAlt} onChange={(e) => markDirty(setImageAlt)(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="article-content">
              Body (Markdown)
            </label>
            <textarea
              id="article-content"
              className="textarea content-edit-body"
              value={content}
              onChange={(e) => setContentDirty(e.target.value)}
            />
          </div>
        </div>
      ) : null}
    </Shell>
  );
}
