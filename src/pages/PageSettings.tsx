import { useEffect, useState } from 'react';
import { api, type Site } from '../api';
import { Shell } from '../components/Shell';
import { I, Link, go, pageStudioPath, sitePage } from '../nav';
import { BLOG_LAYOUTS, DEFAULT_BLOG_LAYOUT, normalizeBlogLayout } from '../../shared/blog-layouts';

export default function PageSettings({
  site,
  sites,
  onSitePatch,
}: {
  site: Site;
  sites: Site[];
  onSitePatch: (site: Site) => void;
}) {
  const currentLayout = normalizeBlogLayout(site.blog_layout);
  const [selected, setSelected] = useState(currentLayout);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    setSelected(normalizeBlogLayout(site.blog_layout));
  }, [site.id, site.blog_layout]);

  async function save() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const r = await api.updateSite(site.id, { blog_layout: selected });
      onSitePatch(r.site);
      setMsg('Saved');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      sites={sites}
      site={site}
      active="page-settings"
      crumb={
        <>
          <Link className="muted" to={sitePage(site.id)}>Main screen</Link>
          <span className="sep">›</span>
          <span className="muted">Programmatic SEO</span>
          <span className="sep">›</span>
          <span className="cur">Page Settings</span>
        </>
      }
      actions={
        <>
          <span className="note">{msg}</span>
          <button className="btn primary" type="button" onClick={save} disabled={busy || selected === currentLayout}>
            Save
          </button>
        </>
      }
    >
      <section className="section">
        <div className="section-head spread">
          <h2 className="section-title">Blog Page</h2>
          <button className="btn primary" type="button" onClick={() => go(pageStudioPath(site.id))}>
            New page
          </button>
        </div>
        <p className="section-note">
          Determines how blog.{site.root_domain || 'example.com'} displays the homepage and article list, taking effect immediately after publishing.
        </p>
        {err ? <p className="flash">{err}</p> : null}
        <div className="layout-grid" role="radiogroup" aria-label="Blog Page">
          {BLOG_LAYOUTS.map((layout) => (
            <button
              key={layout.key}
              type="button"
              role="radio"
              aria-checked={selected === layout.key}
              className={`layout-card${selected === layout.key ? ' on' : ''}`}
              onClick={() => setSelected(layout.key)}
            >
              <span className={`layout-preview pv-${layout.key}`} aria-hidden>
                <i /><i /><i /><i /><i /><i /><i />
              </span>
              <span className="layout-name">
                {layout.name}
                {layout.key === DEFAULT_BLOG_LAYOUT ? <em>Default</em> : null}
              </span>
              <span className="layout-desc">{layout.description}</span>
              {currentLayout === layout.key ? (
                <span className="layout-current">{selected === layout.key ? I.check : null}Currently In Use</span>
              ) : null}
            </button>
          ))}
        </div>
      </section>
    </Shell>
  );
}
