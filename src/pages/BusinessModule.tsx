import { useEffect, useMemo, useState } from 'react';
import {
  businessModuleMarkdown,
  emptyBusinessModuleContent,
  type BusinessModuleContent,
  type BusinessModuleDefinition,
} from '../../shared/business';
import { api, formatDateTime, type BusinessModuleView, type Site } from '../api';
import { Shell } from '../components/Shell';
import { Link, sitePage } from '../nav';

export default function BusinessModulePage({
  site,
  sites,
  definition,
}: {
  site: Site;
  sites: Site[];
  definition: BusinessModuleDefinition;
}) {
  const empty = useMemo(() => emptyBusinessModuleContent(definition.key), [definition.key]);
  const [content, setContent] = useState<BusinessModuleContent>(empty);
  const [saved, setSaved] = useState<BusinessModuleContent>(empty);
  const [meta, setMeta] = useState<BusinessModuleView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    setLoading(true);
    setErr('');
    api.business(site.id)
      .then(({ modules }) => {
        const current = modules.find((module) => module.key === definition.key);
        const next = current?.content ?? empty;
        setContent(next);
        setSaved(next);
        setMeta(current ?? null);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [site.id, definition.key, empty]);

  const dirty = JSON.stringify(content) !== JSON.stringify(saved);

  async function save() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const result = await api.saveBusinessModule(site.id, definition.key, businessModuleMarkdown(definition.key, content));
      setMeta(result.module);
      setContent(result.module.content);
      setSaved(result.module.content);
      setMsg('Saved; the SEO team can now use this information');
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
      active={definition.page}
      crumb={
        <>
          <Link className="muted" to={sitePage(site.id)}>Main screen</Link>
          <span className="sep">›</span>
          <span className="muted">Business info</span>
          <span className="sep">›</span>
          <span className="cur">{definition.label}</span>
        </>
      }
      actions={
        <>
          {meta?.version ? <span className="note">v{meta.version} · {meta.source === 'manual' ? 'Fill in manually' : meta.source} · {formatDateTime(meta.updated_at)}</span> : null}
          <span className="note">{msg}</span>
          <button className="btn primary" type="button" onClick={save} disabled={loading || busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="business-page">
        {err ? <p className="flash">{err}</p> : null}
        <header className="business-hero">
          <span className="business-eyebrow">{definition.eyebrow}</span>
          <h1>{definition.label}</h1>
          <p>{definition.description}</p>
          <div className="business-consumers" aria-label="Teams that use this module">
            <span>Consumers</span>
            {definition.consumers.map((consumer) => <span className="business-consumer" key={consumer}>{consumer}</span>)}
          </div>
        </header>

        <section className="business-form-panel" aria-busy={loading}>
          {loading ? <p className="empty">Loading business info…</p> : definition.fields.map((field) => (
            <label className="business-field-row" key={field.key}>
              <span className="business-field-copy">
                <strong>{field.label}</strong>
                <span>{field.help}</span>
              </span>
              <textarea
                className="textarea"
                rows={field.rows}
                value={content[field.key] ?? ''}
                placeholder={field.placeholder}
                onChange={(event) => setContent((current) => ({ ...current, [field.key]: event.target.value }))}
              />
            </label>
          ))}
        </section>
      </div>
    </Shell>
  );
}
