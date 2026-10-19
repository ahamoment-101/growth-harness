import { articleAliases } from './url-history';
import { emptyJob, getSite, listJobs } from '../db';
import { isSetupArticle, SETUP_LOCALE, SETUP_SLUG } from '../lib/hosting';
import type { ArticleVersion, Site } from '../types';
import { LOCALE_PREFERENCE_PARAM } from './locale-switcher';
import { crawlerHeaders, type BlogSurface } from './indexing';
import {
  articleUrl,
  homeRedirectUrl,
  matchBlogPath,
  matchLivePath,
  preferredLocale,
  robotsTxt,
  totalPages,
  type BlogMatch,
  type LocalePolicy,
} from './seo';
import {
  findLiveArticle,
  localesWithContent,
  publicOrigin,
  publishedLocalePolicy,
  publishedVersions,
  articleUrlsByJobFor,
  renderArticleHtml,
  renderFeedXml,
  renderListHtml,
  renderNotFoundHtml,
  renderSitemapXml,
  renderTrialHtml,
} from './render';

export async function serveLive(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const siteId = liveSiteId(url.pathname);
  if (!siteId) return new Response('Not found', { status: 404 });
  const site = await getSite(env.DB, siteId);
  if (!site) return new Response('Not found', { status: 404 });
  const jobs = await listJobs(env.DB, site.id);
  const policy = publishedLocalePolicy(site, jobs);
  const match = matchLivePath(url.pathname, policy);
  if (!match) return notFound(request, site, false, policy, localesWithContent(jobs));
  const page: BlogMatch =
    match.kind === 'article'
      ? { kind: 'article', locale: match.locale, slug: match.slug }
      : match.kind === 'list'
        ? { kind: 'list', locale: match.locale, page: match.page }
        : match.kind === 'sitemap'
          ? { kind: 'sitemap', part: match.part }
          : match.kind === 'feed'
            ? { kind: 'feed' }
            : match.kind === 'indexnow-key'
              ? { kind: 'indexnow-key' }
              : match.kind === 'redirect'
            ? { kind: 'redirect', pathname: match.pathname }
            : { kind: match.kind };
  return serveBlog(request, env, site, page, false, jobs, policy);
}

export async function serveHosted(request: Request, env: Env, site: Site): Promise<Response> {
  const url = new URL(request.url);
  const jobs = await listJobs(env.DB, site.id);
  const policy = publishedLocalePolicy(site, jobs);
  const match = matchBlogPath(url.pathname, policy);
  if (!match) return notFound(request, site, true, policy, localesWithContent(jobs));
  return serveBlog(request, env, site, match, true, jobs, policy);
}

/**
 * Exported for tests: unlike `serveLive`/`serveHosted`, this takes already-fetched `jobs` rather
 * than a D1 binding, so route-level behaviour (pagination bounds, conditional GET) is directly
 * testable without standing up a database fake.
 */
export async function serveBlog(
  request: Request,
  env: Env,
  site: Site,
  match: BlogMatch,
  hosted: boolean,
  jobs: Awaited<ReturnType<typeof listJobs>>,
  policy: ReturnType<typeof publishedLocalePolicy>,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const response = await renderBlogResponse(request, env, site, match, hosted, jobs, policy);
  if (response.status !== 200) return request.method === 'HEAD' ? new Response(null, response) : response;
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const etag = `"${Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('')}"`;
  const headers = new Headers(response.headers);
  headers.set('ETag', etag);
  // Article timestamps do not describe shell, configuration, link or renderer changes.
  // Only a validator for the complete representation may produce a 304.
  const matches = request.headers.get('If-None-Match')?.split(',').some((value) =>
    value.trim() === '*' || value.trim().replace(/^W\//, '') === etag,
  );
  if (matches && !headers.get('Cache-Control')?.includes('no-store')) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : bytes, { status: response.status, headers });
}

async function renderBlogResponse(
  request: Request, env: Env, site: Site, match: BlogMatch, hosted: boolean,
  jobs: Awaited<ReturnType<typeof listJobs>>, policy: ReturnType<typeof publishedLocalePolicy>,
): Promise<Response> {
  const origin = publicOrigin(new URL(request.url).origin, site, hosted);
  const surface: BlogSurface = hosted ? 'hosted' : 'preview';
  const published = jobs.some((j) => j.status === 'published');
  const availableLocales = localesWithContent(jobs);
  const matchLocale = match.kind === 'list' || match.kind === 'article' ? match.locale : null;
  const preferenceRedirect = localePreferenceRedirect(request, site.id, matchLocale, availableLocales);
  if (preferenceRedirect) return preferenceRedirect;

  if (match.kind === 'robots') {
    return new Response(robotsTxt(origin, surface), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Blog-Agent-Site': site.id },
    });
  }
  if (match.kind === 'sitemap') {
    return new Response(renderSitemapXml(origin, site, jobs, match.part), {
      headers: { ...siteHeaders(site.id, surface), 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }
  if (match.kind === 'feed') {
    return new Response(renderFeedXml(origin, site, jobs), {
      headers: {
        ...siteHeaders(site.id, surface),
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
      },
    });
  }
  if (match.kind === 'indexnow-key') {
    const key = (env as Env & { INDEXNOW_KEY?: string }).INDEXNOW_KEY;
    if (!key) return new Response('Not found', { status: 404 });
    return new Response(key, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (match.kind === 'redirect') {
    return Response.redirect(origin.replace(/\/+$/, '') + match.pathname, 301);
  }
  if (match.kind === 'home') {
    if (published) {
      return localizedHomeRedirect(request, origin, policy, availableLocales, localePreferenceCookieName(site.id));
    }
    return html(renderTrialHtml(origin, site), site.id, { noStore: true, surface });
  }
  if (match.kind === 'list') {
    // A page number past the real last page would otherwise render the last page's content under
    // every larger number forever — an unbounded URL space that costs crawl budget for nothing,
    // since canonical already collapses it. Reject it outright instead.
    const count = publishedVersions(jobs).filter((row) => row.version.locale === match.locale).length;
    if (match.page > totalPages(count)) return notFound(request, site, hosted, policy, localesWithContent(jobs));
    return html(renderListHtml(origin, site, jobs, match.locale, match.page, { surface }), site.id, { surface });
  }

  if (isSetupArticle(match.locale, match.slug) || match.slug === SETUP_SLUG) {
    return html(
      renderArticleHtml(origin, site, setupHit(site), { blocked: 'setup_page', surface }),
      site.id,
      { noStore: true, surface },
    );
  }

  const hit = findLiveArticle(jobs, match.locale, match.slug);
  if (!hit) {
    const aliasJob = jobs.find((job) => job.status === 'published' && job.visibility !== 'hidden'
      && articleAliases(job).some((alias) => alias.locale === match.locale && alias.slug === match.slug));
    const target = aliasJob && publishedVersions([aliasJob]).find((row) => row.version.locale === match.locale);
    if (target) return Response.redirect(articleUrl(origin, policy, target.version.locale, target.version.slug), 301);
    return notFound(request, site, hosted, policy, localesWithContent(jobs));
  }
  return html(renderArticleHtml(origin, site, hit, {
    policy,
    navigationLocales: localesWithContent(jobs),
    surface,
    // Built from the jobs already loaded for routing, so resolving sibling
    // references costs no additional read.
    articleUrlsByJob: articleUrlsByJobFor(origin, policy, match.locale, jobs),
  }), site.id, { surface });
}

export function localizedHomeRedirect(
  request: Request,
  origin: string,
  policy: LocalePolicy,
  localesWithPublishedContent: string[],
  cookieName = 'blog_locale',
): Response {
  const saved = savedLocalePreference(
    request.headers.get('Cookie'),
    cookieName,
    localesWithPublishedContent,
  );
  const english = localesWithPublishedContent.find((code) => code.toLowerCase().split('-')[0] === 'en');
  const fallback = english || (
    localesWithPublishedContent.includes(policy.defaultCode)
      ? policy.defaultCode
      : localesWithPublishedContent[0] || policy.defaultCode
  );
  const locale = saved || preferredLocale(
    request.headers.get('Accept-Language'),
    localesWithPublishedContent,
    fallback,
  );
  return new Response(null, {
    status: 307,
    headers: {
      Location: homeRedirectUrl(origin, policy, [locale]),
      Vary: 'Cookie, Accept-Language',
      'Cache-Control': 'private, no-store',
    },
  });
}

export function localePreferenceCookieName(siteId: string): string {
  return `blog_locale_${siteId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export function savedLocalePreference(
  cookieHeader: string | null,
  cookieName: string,
  availableLocales: string[],
): string | null {
  if (!cookieHeader) return null;
  const raw = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch { /* ignore malformed preference */ }
  return availableLocales.find((code) => code.toLowerCase() === decoded.toLowerCase()) || null;
}

export function localePreferenceRedirect(
  request: Request,
  siteId: string,
  matchLocale: string | null,
  availableLocales: string[],
): Response | null {
  const url = new URL(request.url);
  if (!url.searchParams.has(LOCALE_PREFERENCE_PARAM)) return null;
  const requested = url.searchParams.get(LOCALE_PREFERENCE_PARAM) || '';
  const selected = availableLocales.find((code) => code.toLowerCase() === requested.toLowerCase()) || null;
  url.searchParams.delete(LOCALE_PREFERENCE_PARAM);
  const headers = new Headers({
    Location: url.toString(),
    'Cache-Control': 'private, no-store',
  });
  if (selected && matchLocale?.toLowerCase() === selected.toLowerCase()) {
    headers.set(
      'Set-Cookie',
      `${localePreferenceCookieName(siteId)}=${encodeURIComponent(selected)}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`,
    );
  }
  return new Response(null, { status: 303, headers });
}

function liveSiteId(pathname: string): string | null {
  const m = /^\/live\/([^/]+)/.exec(pathname);
  try { return m ? decodeURIComponent(m[1]) : null; } catch { return null; }
}

function notFound(
  request: Request,
  site: Site,
  hosted: boolean,
  policy?: ReturnType<typeof publishedLocalePolicy>,
  navigationLocales?: string[],
): Response {
  const origin = publicOrigin(new URL(request.url).origin, site, hosted);
  return html(renderNotFoundHtml(origin, site, { policy, navigationLocales }), site.id, {
    status: 404,
    noStore: true,
    surface: hosted ? 'hosted' : 'preview',
  });
}

function setupHit(site: Site): { job: ReturnType<typeof emptyJob>; version: ArticleVersion; siblings: ArticleVersion[] } {
  const version: ArticleVersion = {
    locale: SETUP_LOCALE,
    slug: SETUP_SLUG,
    title: `${site.domain || site.name} is live`,
    excerpt: 'Hosting check page. Not an SEO article.',
    content: [
      `This hostname is served by the content factory for ${site.name}.`,
      '',
      'If you can read this on the customer domain, DNS and TLS are working.',
      '',
      `Site id: ${site.id}`,
    ].join('\n'),
  };
  return {
    job: emptyJob({ id: 'setup', site_id: site.id, status: 'published' }),
    version,
    siblings: [version],
  };
}

function html(
  body: string,
  siteId: string,
  opts: { status?: number; noStore?: boolean; surface?: BlogSurface } = {},
): Response {
  const headers: Record<string, string> = {
    ...siteHeaders(siteId, opts.surface ?? 'hosted'),
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': opts.noStore ? 'no-store' : 'public, max-age=120',
  };
  return new Response(body, { status: opts.status ?? 200, headers });
}

/** Site tag plus whatever the indexability contract wants on the wire for this surface. */
function siteHeaders(siteId: string, surface: BlogSurface): Record<string, string> {
  return { 'X-Blog-Agent-Site': siteId, ...crawlerHeaders(surface) };
}
