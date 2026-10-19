import { useEffect, useState, type ReactNode } from 'react';
import type { BusinessPageKey } from '../shared/business';

export function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export const HOME = '/';

export function go(to: string, mode: 'push' | 'replace' = 'push') {
  if (mode === 'replace') history.replaceState({}, '', to);
  else history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** The site's front door: the classroom. The console lives behind it, starting at the workbench. */
export function classroomPage(siteId: string) {
  return `/website/${siteId}`;
}

export function agentPage(siteId: string, agentId: string, reviewJobId?: string) {
  const query = new URLSearchParams({ agent: agentId });
  if (reviewJobId) query.set('review', reviewJobId);
  return `${classroomPage(siteId)}?${query}`;
}

export function sitePage(siteId: string, page = 'home') {
  if (!page || page === 'home') return `/website/${siteId}/workbench`;
  return `/website/${siteId}/${page}`;
}

export function jobPage(siteId: string, jobId: string) {
  return agentPage(siteId, 'content_production', jobId);
}

export function contentGroupPage(siteId: string, groupId: string) {
  return `/website/${siteId}/articles/groups/${groupId}`;
}

export function contentArticlePage(siteId: string, jobId: string, locale?: string) {
  const base = `/website/${siteId}/content-list/${jobId}`;
  return locale ? `${base}?locale=${encodeURIComponent(locale)}` : base;
}

export function pageStudioPath(siteId: string) {
  return `/website/${siteId}/page-settings/new`;
}

export function Link({
  to,
  className,
  children,
  onClick,
  title,
}: {
  to: string;
  className?: string;
  children: ReactNode;
  onClick?: () => void;
  /** Tooltip and accessible name, for links that show only an icon. */
  title?: string;
}) {
  return (
    <a
      href={to}
      className={className}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.preventDefault();
        onClick?.();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

export type PageKey =
  | 'sites'
  | 'classroom'
  | 'room-activity'
  | 'cabinet'
  | 'home'
  | 'business'
  | 'keywords'
  | 'content-list'
  | 'settings'
  | 'page-settings'
  | 'project-settings'
  | 'seo'
  | 'triggers'
  | 'analytics'
  | BusinessPageKey;

export type Route =
  | { page: 'keyword-topic'; siteId: string; topicId: string }
  | { page: 'sites' }
  | { page: PageKey; siteId: string }
  | { page: 'content-group-detail'; siteId: string; groupId: string }
  | { page: 'content-article'; siteId: string; jobId: string }
  | { page: 'page-studio'; siteId: string };

const SITE_PAGES = new Set<string>([
  'room-activity',
  'cabinet',
  'home',
  'business',
  'keywords',
  'content-list',
  'settings',
  'page-settings',
  'project-settings',
  'seo',
  'triggers',
  'analytics',
  'product',
  'audience',
  'brand',
  'competition',
  'marketing',
  'conversion',
]);

export const SEO_TEAM_PAGES = new Set<string>([
  'keywords',
  'content-list',
  'content-article',
  'content-group-detail',
  'settings',
  'page-settings',
]);

export const ANALYTICS_PAGES = new Set<string>(['seo', 'analytics', 'triggers']);

export function parseRoute(path: string): Route {
  const clean = path.replace(/\/+$/, '') || '/';
  const keywordTopic = /^\/(?:website|s)\/([^/]+)\/keywords\/topics\/([^/]+)$/.exec(clean);
  if (keywordTopic) return { page: 'keyword-topic', siteId: decodeURIComponent(keywordTopic[1]), topicId: decodeURIComponent(keywordTopic[2]) };
  const groupDetail = /^\/(?:website|s)\/([^/]+)\/articles\/groups\/([^/]+)$/.exec(clean);
  if (groupDetail) {
    return { page: 'content-group-detail', siteId: decodeURIComponent(groupDetail[1]), groupId: decodeURIComponent(groupDetail[2]) };
  }
  const articleDetail = /^\/(?:website|s)\/([^/]+)\/content-list\/([^/]+)$/.exec(clean);
  if (articleDetail) {
    return { page: 'content-article', siteId: decodeURIComponent(articleDetail[1]), jobId: decodeURIComponent(articleDetail[2]) };
  }
  const studio = /^\/(?:website|s)\/([^/]+)\/page-settings\/new$/.exec(clean);
  if (studio) {
    return { page: 'page-studio', siteId: decodeURIComponent(studio[1]) };
  }
  const site = /^\/(?:website|s)\/([^/]+)(?:\/([^/]+))?/.exec(clean);
  if (site) {
    const raw = site[2];
    if (!raw) return { page: 'classroom', siteId: decodeURIComponent(site[1]) };
    if (raw === 'workbench' || raw === 'team' || raw === 'overview' || raw === 'home' || raw === 'dashboard') {
      return { page: 'content-list', siteId: decodeURIComponent(site[1]) };
    }
    if (raw === 'business-model' || raw === 'business') return { page: 'cabinet', siteId: decodeURIComponent(site[1]) };
    if (raw === 'room-team') return { page: 'room-activity', siteId: decodeURIComponent(site[1]) };
    if (raw === 'analytics') return { page: 'seo', siteId: decodeURIComponent(site[1]) };
    const page: PageKey = SITE_PAGES.has(raw) ? (raw as PageKey) : 'content-list';
    return { page, siteId: decodeURIComponent(site[1]) };
  }
  return { page: 'sites' };
}

export const I = {
  search: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  ),
  chevron: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  globe: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18-2.5-2.7-2.5-15.3 0-18z" />
    </svg>
  ),
  briefcase: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18" />
    </svg>
  ),
  inbox: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.5 5h13l2.5 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4l2.5-8z" />
      <path d="M3 13h4l2 3h6l2-3h4" />
    </svg>
  ),
  list: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </svg>
  ),
  file: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  ),
  sliders: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h10M18 7h2M4 17h6M14 17h6" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="12" cy="17" r="2" />
    </svg>
  ),
  gear: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  target: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  ),
  chart: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 16l4-6 4 4 5-7" />
    </svg>
  ),
  plus: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  home: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 11.5L12 4l8 7.5" />
      <path d="M7 10.5V20h10v-9.5" />
    </svg>
  ),
  tick: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.5 12.5l4.2 4.2 8.8-9.4" />
    </svg>
  ),
  play: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 5l11 7-11 7V5z" />
    </svg>
  ),
  check: (
    <svg className="glyph ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 12.2l2.4 2.4 4.6-4.9" />
    </svg>
  ),
  warn: (
    <svg className="glyph warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5M12 16h.01" />
    </svg>
  ),
  clock: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2" />
    </svg>
  ),
  wait: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 12V7" />
    </svg>
  ),
  fail: (
    <svg className="glyph bad" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4l9 16H3l9-16z" />
      <path d="M12 10v4M12 17.5h.01" />
    </svg>
  ),
  back: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  ),
  copy: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  ),
  external: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 5h5v5M19 5l-8 8" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  ),
  undo: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9h11a5 5 0 1 1 0 10H8" />
      <path d="M8 5L4 9l4 4" />
    </svg>
  ),
  logout: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
      <path d="M14 8l4 4-4 4M8 12h10" />
    </svg>
  ),
  enter: (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
};
