import { useEffect, useRef, useState } from 'react';
import { api, LANG_OPTIONS, SOURCE_OPTIONS, type Site } from '../api';
import { Shell } from '../components/Shell';
import { I, Link, sitePage } from '../nav';

const LOCALE_LABELS: Record<string, string> = {
  en: 'English',
  'pt-BR': 'Brazilian Portuguese',
  es: 'Spanish',
  'es-MX': 'Mexican Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  'zh-CN': 'Simplified Chinese',
};

const AUTOSAVE_DEBOUNCE_MS = 600;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function ProjectSettings({
  site,
  sites,
  onSitePatch,
}: {
  site: Site;
  sites: Site[];
  onSitePatch: (site: Site) => void;
}) {
  const [name, setName] = useState(site.name);
  const [rootDomain, setRootDomain] = useState(site.root_domain || '');
  const [sourceLocale, setSourceLocale] = useState(site.source_locale || 'en');
  const [langs, setLangs] = useState<string[]>(site.translate_locales);
  const [publicationLanguageMode, setPublicationLanguageMode] = useState<'all_enabled' | 'source_only'>(site.publication_language_mode || 'all_enabled');
  const [names, setNames] = useState<Record<string, string>>(() => savedNames(site));
  const [customLang, setCustomLang] = useState('');
  const [llmBusy, setLlmBusy] = useState<Record<string, boolean>>({});
  const [llmError, setLlmError] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveErr, setSaveErr] = useState('');

  // Locales whose name input the user has typed into — LLM autofill never overwrites these.
  const editedLocales = useRef(new Set<string>());
  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<number | null>(null);
  const flushingRef = useRef(false);
  const siteIdRef = useRef(site.id);
  siteIdRef.current = site.id;

  // Locale is enabled if it is the source (non-en) or a selected translate locale.
  const enabledLocalesRef = useRef<string[]>([]);
  enabledLocalesRef.current = [
    ...new Set([sourceLocale !== 'en' ? sourceLocale : '', ...langs].filter(Boolean)),
  ];

  const nameLocales = enabledLocalesRef.current;

  // Existing projects: autofill any enabled locale that has no stored name yet (once per page load).
  const didMountFill = useRef(false);
  useEffect(() => {
    if (didMountFill.current) return;
    didMountFill.current = true;
    for (const code of enabledLocalesRef.current) {
      if (!names[code] && !savedNameFor(code)) void fillNameFor(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function mergePending(patch: Record<string, unknown>) {
    const merged = { ...pendingRef.current };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'name_by_locale' && value && typeof value === 'object') {
        merged[key] = { ...((merged[key] as Record<string, unknown>) ?? {}), ...(value as Record<string, unknown>) };
      } else {
        merged[key] = value;
      }
    }
    pendingRef.current = merged;
  }

  function schedule(patch: Record<string, unknown>) {
    mergePending(patch);
    setSaveState('saving');
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, AUTOSAVE_DEBOUNCE_MS);
  }

  async function flush() {
    if (flushingRef.current) {
      // A save is in flight; re-arm so pending changes are not dropped.
      timerRef.current = window.setTimeout(flush, AUTOSAVE_DEBOUNCE_MS);
      return;
    }
    flushingRef.current = true;
    try {
      while (Object.keys(pendingRef.current).length) {
        const body = pendingRef.current;
        pendingRef.current = {};
        try {
          const r = await api.updateSite(siteIdRef.current, body);
          onSitePatch(r.site);
        } catch (e) {
          // Put the failed body back so the next edit retries it.
          mergePending(body);
          throw e;
        }
      }
      setSaveState('saved');
      setSaveErr('');
    } catch (e) {
      setSaveState('error');
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      flushingRef.current = false;
    }
  }

  function savedNameFor(code: string): string {
    const entry = site.name_by_locale?.[code];
    return entry?.value ? entry.value : '';
  }

  /** Fill a freshly enabled locale: restore the saved name, or ask the LLM once. */
  async function fillNameFor(code: string) {
    const saved = savedNameFor(code);
    if (saved) {
      // Restore wins even for locales the user edited — tombstoned edits come back.
      setNames((m) => ({ ...m, [code]: saved }));
      schedule({ name_by_locale: { [code]: saved } });
      return;
    }
    // No stored value: only autofill if the user has not typed here this session.
    if (editedLocales.current.has(code)) return;
    if (llmBusy[code]) return;
    setLlmBusy((m) => ({ ...m, [code]: true }));
    setLlmError((m) => ({ ...m, [code]: '' }));
    try {
      const r = await api.translateSiteName(site.id, { locale: code, name: name.trim() || site.name });
      const stillEnabled = enabledLocalesRef.current.includes(code);
      if (!stillEnabled || editedLocales.current.has(code)) return;
      setNames((m) => ({ ...m, [code]: r.name }));
      schedule({ name_by_locale: { [code]: r.name } });
    } catch (e) {
      if (enabledLocalesRef.current.includes(code)) {
        setLlmError((m) => ({ ...m, [code]: e instanceof Error ? e.message : String(e) }));
      }
    } finally {
      setLlmBusy((m) => ({ ...m, [code]: false }));
    }
  }

  function onNameChange(value: string) {
    setName(value);
    if (value.trim()) schedule({ name: value });
  }

  function onLocalizedNameChange(code: string, value: string) {
    editedLocales.current.add(code);
    setLlmError((m) => ({ ...m, [code]: '' }));
    setNames((m) => ({ ...m, [code]: value }));
    schedule({ name_by_locale: { [code]: value } });
  }

  function onRootDomainChange(value: string) {
    setRootDomain(value);
    if (value.trim()) schedule({ root_domain: value });
  }

  function toggleLang(code: string) {
    if (code === sourceLocale) return;
    if (langs.includes(code)) {
      const nextLangs = langs.filter((x) => x !== code);
      setLangs(nextLangs);
      setNames((m) => ({ ...m, [code]: '' }));
      setLlmError((m) => ({ ...m, [code]: '' }));
      // Soft delete: keep the value server-side so re-enabling restores it.
      schedule({ translate_locales: nextLangs, name_by_locale: { [code]: { deleted: true } } });
    } else {
      const nextLangs = [...langs, code];
      setLangs(nextLangs);
      schedule({ translate_locales: nextLangs });
      void fillNameFor(code);
    }
  }

  function changeSource(next: string) {
    setSourceLocale(next);
    const nextLangs = langs.filter((x) => x !== next);
    setLangs(nextLangs);
    schedule({ source_locale: next, translate_locales: nextLangs });
    if (next !== 'en' && !names[next]) void fillNameFor(next);
  }

  function addCustom() {
    const code = customLang.trim();
    if (code && code !== sourceLocale && !langs.includes(code)) {
      setLangs([...langs, code]);
      schedule({ translate_locales: [...langs, code] });
      void fillNameFor(code);
    }
    setCustomLang('');
  }

  const enabled = [sourceLocale, ...langs.filter((code) => code && code !== sourceLocale)];

  return (
    <Shell
      sites={sites}
      site={site}
      active="project-settings"
      crumb={
        <>
          <Link className="muted" to={sitePage(site.id)}>Main screen</Link>
          <span className="sep">›</span>
          <span className="cur">Project Settings</span>
        </>
      }
      actions={
        <span className="note">
          {saveState === 'saving'
            ? 'Saving…'
            : saveState === 'error'
              ? `Save failed: ${saveErr}`
              : saveState === 'saved'
                ? 'Saved'
                : 'Changes are saved automatically'}
        </span>
      }
    >
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Project</h2>
        </div>
        <p className="section-note">One domain per project. The name appears in the console and on the blog site; the domain is the project's public-facing identity.</p>
        {saveState === 'error' ? <p className="flash">{`Save failed: ${saveErr}`}</p> : null}
        <div className="kv">
          <div className="kv-k">
            Name<span className="sub">English · base language, cannot be deleted</span>
          </div>
          <div className="kv-v">
            <input
              className="input"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              onBlur={() => {
                if (!name.trim()) setName(site.name);
              }}
              placeholder={rootDomain || 'Project name'}
            />
          </div>
          <div className="state-text">Other languages are translated separately and do not follow changes made here</div>
        </div>
        {nameLocales.map((code) => (
          <div className="kv" key={code}>
            <div className="kv-k">{localeLabel(code)}<span className="sub">Project name</span></div>
            <div className="kv-v">
              <input
                className="input"
                value={names[code] ?? ''}
                onChange={(e) => onLocalizedNameChange(code, e.target.value)}
                placeholder={llmBusy[code] ? 'AI translating…' : 'Fill in manually if loading fails'}
              />
            </div>
            <div className="state-text">
              {llmBusy[code] ? 'AI translating…' : llmError[code] ? (
                <button className="chip" type="button" onClick={() => void fillNameFor(code)}>Retry translation</button>
              ) : (
                'Auto-save'
              )}
            </div>
          </div>
        ))}
        <div className="kv">
          <div className="kv-k">
            Domain<span className="sub">Project identity</span>
          </div>
          <div className="kv-v">
            <input className="input mono" value={rootDomain} onChange={(e) => onRootDomainChange(e.target.value)} placeholder="example.com" />
          </div>
          <div className="state-text">Paths and prefixes are stripped automatically</div>
        </div>
      </section>
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Project languages</h2>
        </div>
        <p className="section-note">This is the project's only language switch. SEO strategy and topic selection run independently per language; content is written as a native-language draft in the language of the current topic selection, then versions for other languages are generated. The language list also determines the URL prefix of the blog subdomain (pt-BR defaults to /pt/blog).</p>
        <div className="kv">
          <div className="kv-k">
            Primary language<span className="sub">Project default language</span>
          </div>
          <div className="kv-v">
            <select className="select" value={sourceLocale} onChange={(e) => changeSource(e.target.value)}>
              {sourceOptions(sourceLocale).map((code) => (
                <option key={code} value={code}>
                  {localeLabel(code)}
                </option>
              ))}
            </select>
          </div>
          <div className="state-text">Changeable</div>
        </div>
        <div className="kv">
          <div className="kv-k">Other enabled languages</div>
          <div className="kv-v lang-chips">
            {langOptions(sourceLocale, langs).map((code) => (
              <button key={code} className={`chip${langs.includes(code) ? ' on' : ''}`} type="button" onClick={() => toggleLang(code)}>
                {localeLabel(code)}
              </button>
            ))}
            <input
              className="input"
              style={{ width: 88, height: 24 }}
              value={customLang}
              onChange={(e) => setCustomLang(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustom();
                }
              }}
              placeholder="es-AR"
            />
            <button className="chip" type="button" onClick={addCustom}>
              {I.plus}Other
            </button>
          </div>
          <div className="state-text">{enabled.length}  languages</div>
        </div>
        <div className="kv">
          <div className="kv-k">Article publishing languages<span className="sub">How to handle missing language versions at publish time</span></div>
          <div className="kv-v">
            <select
              className="select"
              value={publicationLanguageMode}
              onChange={(e) => {
                const mode = e.target.value as 'all_enabled' | 'source_only';
                setPublicationLanguageMode(mode);
                schedule({ publication_language_mode: mode });
              }}
            >
              <option value="all_enabled">Automatically fill in all enabled languages (default)</option>
              <option value="source_only">Publish the article in its original language first; fill in other languages manually</option>
            </select>
          </div>
          <div className="state-text">Auto-save</div>
        </div>
        <div className="kv">
          <div className="kv-k">
            Public path<span className="sub">The prefix stays unchanged after publishing; changing the prefix goes through the API with a 301</span>
          </div>
          <div className="kv-v lang-chips">
            {(site.locale_policy?.locales ?? []).map((l) => (
              <span key={l.code} className="chip on fixed">
                /{l.prefix}/blog
              </span>
            ))}
          </div>
          <div className="state-text">{site.locale_policy?.locales.length ?? 0}  languages</div>
        </div>
      </section>
    </Shell>
  );
}

/** Live (non-deleted) per-locale names from the last saved state. */
function savedNames(site: Site): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, entry] of Object.entries(site.name_by_locale ?? {})) {
    if (entry?.value && !entry.deleted_at) out[code] = entry.value;
  }
  return out;
}

function localeLabel(code: string) {
  return LOCALE_LABELS[code] ? `${code} · ${LOCALE_LABELS[code]}` : code;
}

function sourceOptions(current: string): string[] {
  return SOURCE_OPTIONS.includes(current) ? SOURCE_OPTIONS : [current, ...SOURCE_OPTIONS];
}

function langOptions(source: string, current: string[]): string[] {
  const known = LANG_OPTIONS.filter((code) => code !== source);
  const extra = current.filter((code) => code && code !== source && !known.includes(code));
  return [...known, ...extra];
}
