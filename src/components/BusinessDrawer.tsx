import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { businessModuleByKey, type BusinessModuleKey } from '../../shared/business';
import { api, formatDateTime, type BusinessModuleView, type Site } from '../api';
import { useEscapeDismiss } from './escapeDismiss';

export function BusinessDrawer({ site, moduleKey, onClose }: { site: Site; moduleKey: BusinessModuleKey; onClose: () => void }) {
  const definition = businessModuleByKey(moduleKey)!;
  const [module, setModule] = useState<BusinessModuleView | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setModule(null); setErr('');
    api.business(site.id).then(({ modules }) => {
      const next = modules.find((item) => item.key === moduleKey)!;
      setModule(next); setMarkdown(next.markdown);
    }).catch((error: Error) => setErr(error.message));
  }, [site.id, moduleKey]);

  const dirty = Boolean(module && markdown !== module.markdown);
  function requestClose() {
    if (dirty && !window.confirm('The document has unsaved changes. Are you sure you want to close it?')) return;
    onClose();
  }
  useEscapeDismiss(true, layer, requestClose);
  async function save() {
    setBusy(true); setErr('');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await api.saveBusinessModule(site.id, moduleKey, markdown, controller.signal);
      setModule(result.module); setMarkdown(result.module.markdown);
    } catch (error) {
      setErr(error instanceof DOMException && error.name === 'AbortError'
        ? 'Save timed out. Please check your network and try again'
        : error instanceof Error ? error.message : String(error));
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  }

  return createPortal(<div ref={layer} className="business-drawer-layer" role="dialog" aria-modal="true" aria-label={`${definition.label} document`}>
    <button className="business-drawer-backdrop" type="button" aria-label="Close business info" onClick={requestClose} />
    <aside className="business-drawer">
      <header className="business-drawer-head">
        <div><span className="business-eyebrow">Business info / MD</span><h2>{definition.label}</h2></div>
        <div className="business-drawer-actions"><button className="btn" type="button" onClick={requestClose}>Close</button><button className="btn primary" type="button" disabled={!dirty || busy || !module} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
      </header>
      <p className="business-drawer-note">{definition.description}</p>
      {module?.version ? <p className="note">v{module.version} · {module.source === 'manual' ? 'Fill in manually' : module.source === 'website_research' ? 'Web research · Pending confirmation' : module.source} · {formatDateTime(module.updated_at)}</p> : null}
      {err ? <p className="flash">{err}</p> : null}
      <textarea className="business-markdown" value={markdown} onChange={(event) => setMarkdown(event.target.value)} spellCheck={false} placeholder="Loading document…" disabled={!module} />
    </aside>
  </div>, document.body);
}
