import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { api, type Site } from '../api';
import { I, Link, classroomPage, sitePage, type PageKey } from '../nav';
import { isTopmostDismissLayer } from './escapeDismiss';

export function Shell({
  sites,
  site,
  active,
  crumb,
  actions,
  tabs,
  className,
  children,
}: {
  sites: Site[];
  site: Site | null;
  active: PageKey | 'sites' | 'content-article';
  crumb: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const current = site || sites[0] || null;

  return (
    <div className={`app${className ? ` ${className}` : ''}`}>
      <aside className="sidebar">
        <nav className="side-nav">
          {current ? <NavItem to={classroomPage(current.id)} icon={I.back} label="Back to classroom" active={false} /> : null}
          {current ? (
            <>
              <p className="side-group">Data Analytics</p>
              <NavItem
                to={sitePage(current.id, 'seo')}
                label="SEO Data"
                active={active === 'seo'}
                child
              />
              <NavItem to={sitePage(current.id, 'triggers')} label="Trigger Mechanism" active={active === 'triggers'} child />
              <p className="side-group">Programmatic SEO</p>
              <NavItem to={sitePage(current.id, 'content-list')} label="Content List" active={active === 'content-list' || active === 'content-article'} child />
              <NavItem to={sitePage(current.id, 'page-settings')} label="Page Settings" active={active === 'page-settings'} child />
              <NavItem to={sitePage(current.id, 'keywords')} label="Keyword Library" active={active === 'keywords'} child />
              <NavItem to={sitePage(current.id, 'settings')} label="Configuration" active={active === 'settings'} child />
            </>
          ) : null}
          <a className="side-item" href="/account">Account &amp; Sign-in</a>
        </nav>
      </aside>
      <main className="sheet">
        <header className="sheet-head">
          <div className="crumb">{crumb}</div>
          {actions ? <div className="head-actions">{actions}</div> : null}
        </header>
        {tabs ? <nav className="tabs">{tabs}</nav> : null}
        <div className="scroll">{children}</div>
      </main>
    </div>
  );
}

function AccountActions() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function logout() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.logout();
      window.location.replace('/login?logged_out=1');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-out failed, please retry');
      setBusy(false);
    }
  }
  return <>
    <a className="switcher-action" href="/account">Account &amp; Sign-in</a>
    {error ? <p className="side-logout-error" role="alert">{error}</p> : null}
    <button type="button" className="switcher-action" disabled={busy} onClick={() => void logout()}>
      {I.logout}{busy ? 'Signing out…' : 'Sign out'}
    </button>
  </>;
}

/** Closes an open popover on a click outside `root` or on Escape. */
export function useDismiss(root: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented || !isTopmostDismissLayer(root.current?.querySelector('.switcher-menu') ?? null)) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [root, open, close]);
}

/** The site list with "add a site" below it; `classroomLink` adds the way back to the current site's classroom. */
export function SiteMenu({
  sites,
  current,
  onSwitch,
  onClose,
  classroomLink = false,
}: {
  sites: Site[];
  current: Site;
  onSwitch: (next: Site) => void;
  onClose: () => void;
  classroomLink?: boolean;
}) {
  function pick(next: Site) {
    onClose();
    if (next.id !== current.id) onSwitch(next);
  }

  return (
    <div className="switcher-menu" role="listbox" aria-label="Switch site">
      <div className="switcher-list">
        {sites.map((s) => {
          const selected = s.id === current.id;
          const title = s.name || s.root_domain || s.domain || 'Site';
          const meta = s.root_domain && s.root_domain !== title ? s.root_domain : s.domain && s.domain !== title ? s.domain : '';
          return (
            <div key={s.id} className="switcher-row">
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className={`switcher-item${selected ? ' current' : ''}`}
                onClick={() => pick(s)}
              >
                <SiteIcon site={s} />
                <span className="switcher-copy">
                  <span className="switcher-name">{title}</span>
                  {meta ? <span className="switcher-meta">{meta}</span> : null}
                </span>
                {selected ? <span className="switcher-tick">{I.tick}</span> : null}
              </button>
              <Link to={sitePage(s.id, 'project-settings')} className="switcher-gear" title={`${title} Project Settings`} onClick={onClose}>
                {I.gear}
              </Link>
            </div>
          );
        })}
      </div>
      <div className="switcher-foot">
        <Link to="/?new=1" className="switcher-action" onClick={onClose}>
          {I.plus}
          Add site
        </Link>
        <AccountActions />
        {classroomLink ? (
          <Link to={classroomPage(current.id)} className="switcher-action" onClick={onClose}>
            {I.back}
            Back to classroom
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** The site's own logo when it has one, else its favicon; empty when neither can be resolved. */
export function siteLogoUrl(site: Site, size = 64) {
  const host = hostname(site.root_domain || site.domain);
  const logo = site.seo_identity?.logoUrl;
  if (logo && /^https?:\/\//i.test(logo)) return logo;
  return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}` : '';
}

function SiteIcon({ site }: { site: Site }) {
  const [failed, setFailed] = useState(false);
  const host = hostname(site.root_domain || site.domain);
  const letter = (site.name || host || 'W').slice(0, 1).toUpperCase();
  const src = siteLogoUrl(site);

  if (!src || failed) {
    return <span className="brand-mark">{letter}</span>;
  }

  return (
    <img
      className="brand-favicon"
      src={src}
      alt=""
      width={18}
      height={18}
      onError={() => setFailed(true)}
    />
  );
}

function hostname(domain: string) {
  const raw = (domain || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return raw.replace(/^https?:\/\//, '').split('/')[0];
  }
}

function NavItem({
  to,
  icon,
  label,
  active,
  count,
  child,
  muted,
}: {
  to: string;
  icon?: ReactNode;
  label: string;
  active: boolean;
  count?: number;
  child?: boolean;
  muted?: boolean;
}) {
  return (
    <Link to={to} className={`side-item${child ? ' child' : ''}${active ? ' active' : ''}${muted ? ' muted' : ''}`}>
      {icon}
      <span className="side-label">{label}</span>
      {count != null && count > 0 ? <span className="side-count">{count}</span> : null}
    </Link>
  );
}
