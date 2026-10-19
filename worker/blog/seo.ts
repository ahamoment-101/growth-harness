/** Per-site public URL + head contract. Tenant brands and product URLs stay in site data. */

import { robotsDirective, robotsTxtFor, type BlogSurface, type IndexDecision } from './indexing';
import { publicHttpUrl } from '../../shared/article-presentation';

export const LIST_PAGE_SIZE = 50;
export const SITEMAP_URL_LIMIT = 50_000;

export type LocaleEntry = { code: string; prefix: string };
export type LocaleRedirect = { fromPrefix: string; toPrefix: string };

export type LocalePolicy = {
  defaultCode: string;
  locales: LocaleEntry[];
  redirects: LocaleRedirect[];
};

export type SeoIdentity = {
  organizationName?: string;
  organizationUrl?: string;
  logoUrl?: string;
  defaultOgImage?: string;
  authorName?: string;
  titleByLocale?: Record<string, string>;
  descriptionByLocale?: Record<string, string>;
};

export type LocalePolicySource = {
  locale_policy_json?: string | null;
  translate_locales_json?: string | null;
  source_locale?: string | null;
  hub_urls_json?: string | null;
  seo_identity_json?: string | null;
  product_origin?: string | null;
  hub_path?: string | null;
  name?: string | null;
};

export type Alternate = { hreflang: string; href: string };

export type SeoHead = {
  imageAlt?: string;
  publishedTime?: string;
  modifiedTime?: string;
  lang: string;
  title: string;
  description?: string;
  canonical: string;
  robots: string;
  alternates: Alternate[];
  ogType: 'website' | 'article';
  siteName: string;
  image?: string;
  prev?: string;
  next?: string;
  jsonLd?: unknown;
};

export type BlogMatch =
  | { kind: 'home' }
  | { kind: 'robots' }
  | { kind: 'sitemap'; part?: number }
  | { kind: 'feed' }
  | { kind: 'indexnow-key' }
  | { kind: 'list'; locale: string; page: number }
  | { kind: 'article'; locale: string; slug: string }
  | { kind: 'redirect'; pathname: string };

export type LiveMatch =
  | { kind: 'home'; siteId: string }
  | { kind: 'robots'; siteId: string }
  | { kind: 'sitemap'; siteId: string; part?: number }
  | { kind: 'feed'; siteId: string }
  | { kind: 'indexnow-key'; siteId: string }
  | { kind: 'list'; siteId: string; locale: string; page: number }
  | { kind: 'article'; siteId: string; locale: string; slug: string }
  | { kind: 'redirect'; siteId: string; pathname: string };

export type PublicHrefContext = {
  origin: string;
  productOrigin: string;
  hubPath: string;
  hubUrls: Record<string, string>;
  /** job_id -> that article's URL in the locale being rendered. A group is
   * written in parallel, so at writing time a sibling has no slug yet and its
   * job id is the only stable way to point at it. */
  articleUrlsByJob?: Record<string, string>;
  locale: string;
  policy: LocalePolicy;
};

export type PolicyIssue = { code: string; message: string };

export class LocalePolicyError extends Error {
  issues: PolicyIssue[];
  constructor(issues: PolicyIssue[]) {
    super(issues.map((i) => i.message).join('; ') || 'invalid locale policy');
    this.name = 'LocalePolicyError';
    this.issues = issues;
  }
}

const PREFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODE_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const RESERVED_PREFIXES = new Set(['live', 'api', 'www', 'sitemap', 'robots', 'robots.txt', 'sitemap.xml']);

export function uniqueCodes(codes: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of codes) {
    const code = raw.trim();
    const key = code.toLowerCase();
    if (!code || seen.has(key)) continue;
    seen.add(key);
    out.push(code);
  }
  return out;
}

export function sourceLocaleOf(site?: { source_locale?: string | null } | null): string {
  const v = site?.source_locale?.trim();
  return v || 'en';
}

export function defaultPrefixFor(code: string, used: Iterable<string>): string {
  const taken = new Set([...used].map((p) => p.toLowerCase()));
  const lang = (code.split('-')[0] || code).toLowerCase();
  const full = code.toLowerCase();
  for (const candidate of [lang, full]) {
    if (PREFIX_RE.test(candidate) && !taken.has(candidate) && !RESERVED_PREFIXES.has(candidate)) return candidate;
  }
  for (let i = 2; i < 12; i++) {
    const candidate = `${full}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${full}-x`;
}

export function emptyPolicy(defaultCode: string): LocalePolicy {
  const code = defaultCode.trim() || 'en';
  return { defaultCode: code, locales: [{ code, prefix: defaultPrefixFor(code, []) }], redirects: [] };
}

export function mergeLocalePolicy(codes: string[], existing?: LocalePolicy | null, defaultCode?: string): LocalePolicy {
  const wanted = uniqueCodes(codes.length ? codes : [existing?.defaultCode || defaultCode || 'en']);
  const kept = new Map((existing?.locales ?? []).map((l) => [l.code, l.prefix]));
  const locales: LocaleEntry[] = [];
  const used = new Set<string>();
  for (const code of wanted) {
    const prior = kept.get(code);
    const prefix = prior && !used.has(prior.toLowerCase()) ? prior : defaultPrefixFor(code, used);
    used.add(prefix.toLowerCase());
    locales.push({ code, prefix });
  }
  const fallback = locales[0]?.code || 'en';
  const preferred = defaultCode && wanted.includes(defaultCode)
    ? defaultCode
    : existing?.defaultCode && wanted.includes(existing.defaultCode)
      ? existing.defaultCode
      : fallback;
  return {
    defaultCode: preferred,
    locales,
    redirects: compactRedirects(existing?.redirects ?? [], locales),
  };
}

export function localePolicyFromCodes(codes: string[], defaultCode?: string): LocalePolicy {
  return mergeLocalePolicy(codes, null, defaultCode);
}

export function applyLocalePolicyChange(previous: LocalePolicy | null, next: LocalePolicy): LocalePolicy {
  const redirects = [...(previous?.redirects ?? []), ...(next.redirects ?? [])];
  if (previous) {
    for (const old of previous.locales) {
      const now = next.locales.find((l) => l.code === old.code);
      if (now && now.prefix !== old.prefix) redirects.push({ fromPrefix: old.prefix, toPrefix: now.prefix });
    }
  }
  const merged = { ...next, redirects: compactRedirects(redirects, next.locales) };
  const issues = validateLocalePolicy(merged);
  if (issues.length) throw new LocalePolicyError(issues);
  return merged;
}

export function validateLocalePolicy(policy: LocalePolicy): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  if (!policy.locales.length) issues.push({ code: 'locales', message: 'at least one locale is required' });
  const codes = new Set<string>();
  const prefixes = new Set<string>();
  for (const row of policy.locales) {
    if (!CODE_RE.test(row.code)) issues.push({ code: 'locale_code', message: `invalid locale code ${row.code}` });
    if (codes.has(row.code)) issues.push({ code: 'locale_dup', message: `duplicate locale ${row.code}` });
    codes.add(row.code);
    if (!PREFIX_RE.test(row.prefix) || RESERVED_PREFIXES.has(row.prefix)) {
      issues.push({ code: 'prefix', message: `invalid URL prefix ${row.prefix}` });
    }
    const key = row.prefix.toLowerCase();
    if (prefixes.has(key)) issues.push({ code: 'prefix_dup', message: `duplicate URL prefix ${row.prefix}` });
    prefixes.add(key);
  }
  if (policy.defaultCode && !codes.has(policy.defaultCode)) {
    issues.push({ code: 'default', message: `default locale ${policy.defaultCode} is not in the locale list` });
  }
  for (const red of policy.redirects ?? []) {
    if (!PREFIX_RE.test(red.fromPrefix) || !PREFIX_RE.test(red.toPrefix)) {
      issues.push({ code: 'redirect', message: `invalid redirect ${red.fromPrefix} → ${red.toPrefix}` });
    }
    if (!policy.locales.some((l) => l.prefix === red.toPrefix)) {
      issues.push({ code: 'redirect_target', message: `redirect target ${red.toPrefix} is not a current prefix` });
    }
  }
  return issues;
}

export function parseLocalePolicy(raw: string | null | undefined): LocalePolicy | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as {
      default?: string;
      default_code?: string;
      defaultCode?: string;
      locales?: unknown;
      redirects?: unknown;
    };
    if (!Array.isArray(parsed.locales) || parsed.locales.length === 0) return null;
    const locales: LocaleEntry[] = [];
    for (const row of parsed.locales) {
      if (!row || typeof row !== 'object') continue;
      const rec = row as { code?: unknown; prefix?: unknown };
      const code = typeof rec.code === 'string' ? rec.code.trim() : '';
      const prefix = typeof rec.prefix === 'string' ? rec.prefix.trim().replace(/^\/+|\/+$/g, '') : '';
      if (!code || !prefix) continue;
      locales.push({ code, prefix });
    }
    if (!locales.length) return null;
    const redirects: LocaleRedirect[] = [];
    if (Array.isArray(parsed.redirects)) {
      for (const row of parsed.redirects) {
        if (!row || typeof row !== 'object') continue;
        const rec = row as { fromPrefix?: unknown; toPrefix?: unknown };
        const fromPrefix = typeof rec.fromPrefix === 'string' ? rec.fromPrefix.trim() : '';
        const toPrefix = typeof rec.toPrefix === 'string' ? rec.toPrefix.trim() : '';
        if (fromPrefix && toPrefix) redirects.push({ fromPrefix, toPrefix });
      }
    }
    const fallback = locales[0].code;
    const wanted = parsed.defaultCode || parsed.default_code || parsed.default || fallback;
    return {
      defaultCode: locales.some((l) => l.code === wanted) ? wanted : fallback,
      locales,
      redirects: compactRedirects(redirects, locales),
    };
  } catch {
    return null;
  }
}

export function localeCodesOf(site: LocalePolicySource): string[] {
  const source = sourceLocaleOf(site);
  let extra: string[] = [];
  try {
    const parsed = site.translate_locales_json ? (JSON.parse(site.translate_locales_json) as unknown) : [];
    extra = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    extra = [];
  }
  return uniqueCodes([source, ...extra]);
}

export function localePolicyOf(site: LocalePolicySource, requiredCodes: string[] = []): LocalePolicy {
  const stored = parseLocalePolicy(site.locale_policy_json);
  const codes = uniqueCodes([
    ...localeCodesOf(site),
    ...(stored?.locales.map((locale) => locale.code) ?? []),
    ...requiredCodes,
  ]);
  const merged = mergeLocalePolicy(codes, stored, stored?.defaultCode || sourceLocaleOf(site));
  return merged;
}

export function persistableLocalePolicy(
  site: LocalePolicySource,
  explicit?: LocalePolicy | null,
  requiredCodes: string[] = [],
): LocalePolicy {
  const previous = parseLocalePolicy(site.locale_policy_json);
  const requested = explicit
    ? applyLocalePolicyChange(previous, { ...explicit, redirects: explicit.redirects ?? [] })
    : mergeLocalePolicy(localeCodesOf(site), previous, previous?.defaultCode || sourceLocaleOf(site));
  const preserved: LocalePolicy = {
    ...requested,
    locales: [
      ...requested.locales,
      ...(previous?.locales.filter(
        (locale) => requiredCodes.some((required) => required.toLowerCase() === locale.code.toLowerCase()) &&
          !requested.locales.some(
            (requestedLocale) => requestedLocale.code.toLowerCase() === locale.code.toLowerCase(),
          ),
      ) ?? []),
    ],
  };
  const required = uniqueCodes([
    ...preserved.locales.map((locale) => locale.code),
    ...requiredCodes,
  ]);
  const merged = mergeLocalePolicy(required, preserved, requested.defaultCode);
  const issues = validateLocalePolicy(merged);
  if (issues.length) throw new LocalePolicyError(issues);
  return merged;
}

export function prefixOf(policy: LocalePolicy, code: string): string {
  const hit = policy.locales.find((l) => l.code === code);
  if (hit) return hit.prefix;
  return defaultPrefixFor(code, policy.locales.map((l) => l.prefix));
}

export function codeFromPrefix(policy: LocalePolicy, prefix: string): string | null {
  const key = prefix.trim().toLowerCase();
  const hit = policy.locales.find((l) => l.prefix.toLowerCase() === key);
  return hit?.code ?? null;
}

export function redirectTargetPrefix(policy: LocalePolicy, prefix: string): string | null {
  const key = prefix.trim().toLowerCase();
  const hit = policy.redirects.find((r) => r.fromPrefix.toLowerCase() === key);
  return hit?.toPrefix ?? null;
}

export function stripTrailingSlash(path: string): string {
  if (path === '/') return '/';
  return path.replace(/\/+$/, '') || '/';
}

export function originOf(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function normalizeProductOrigin(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const url = new URL(withProto);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

export function joinUrl(origin: string, path: string): string {
  const base = originOf(origin);
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

export function listPath(policy: LocalePolicy, locale: string, page = 1): string {
  const base = `/${prefixOf(policy, locale)}/blog`;
  return page > 1 ? `${base}/page/${page}` : base;
}

export function articlePath(policy: LocalePolicy, locale: string, slug: string): string {
  return `/${prefixOf(policy, locale)}/blog/${slug}`;
}

export function listUrl(origin: string, policy: LocalePolicy, locale: string, page = 1): string {
  return joinUrl(origin, listPath(policy, locale, page));
}

export function articleUrl(origin: string, policy: LocalePolicy, locale: string, slug: string): string {
  return joinUrl(origin, articlePath(policy, locale, slug));
}

export function homeRedirectPath(policy: LocalePolicy, localesWithContent: string[] = []): string {
  const pick = localesWithContent.includes(policy.defaultCode)
    ? policy.defaultCode
    : localesWithContent[0] || policy.defaultCode;
  return listPath(policy, pick);
}

export function homeRedirectUrl(origin: string, policy: LocalePolicy, localesWithContent: string[] = []): string {
  return joinUrl(origin, homeRedirectPath(policy, localesWithContent));
}

export function preferredLocale(
  acceptLanguage: string | null | undefined,
  availableCodes: string[],
  defaultCode: string,
): string {
  const available = uniqueCodes(availableCodes);
  if (!available.length) return defaultCode;
  const byExact = new Map(available.map((code) => [code.toLowerCase(), code]));
  const weighted = (acceptLanguage || '')
    .split(',')
    .map((part, order) => {
      const [rawCode, ...params] = part.trim().split(';');
      const qParam = params.find((param) => param.trim().toLowerCase().startsWith('q='));
      const parsedQ = qParam ? Number(qParam.trim().slice(2)) : 1;
      return { code: rawCode.trim().toLowerCase(), q: Number.isFinite(parsedQ) ? parsedQ : 0, order };
    })
    .filter((entry) => entry.code && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.order - b.order);

  for (const requested of weighted) {
    if (requested.code === '*') return available.includes(defaultCode) ? defaultCode : available[0];
    const exact = byExact.get(requested.code);
    if (exact) return exact;
    const base = requested.code.split('-')[0];
    const baseMatch = available.find((code) => code.toLowerCase().split('-')[0] === base);
    if (baseMatch) return baseMatch;
  }
  return available.includes(defaultCode) ? defaultCode : available[0];
}

export function isBlogPath(policy: LocalePolicy, path: string): boolean {
  const p = stripTrailingSlash(path);
  const prefixes = [
    ...policy.locales.map((l) => l.prefix),
    ...policy.redirects.map((r) => r.fromPrefix),
  ];
  return prefixes.some((prefix) => p === `/${prefix}/blog` || p.startsWith(`/${prefix}/blog/`));
}

export function parseHubUrls(raw: string | null | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [code, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const url = absoluteHttpUrl(value);
      if (url) out[code.trim()] = url;
    }
    return out;
  } catch {
    return {};
  }
}

export function parseSeoIdentity(raw: string | null | undefined): SeoIdentity {
  if (!raw?.trim()) return {};
  try {
    return normalizeSeoIdentity(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function normalizeSeoIdentity(value: unknown): SeoIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: SeoIdentity = {};
  for (const key of ['organizationName', 'organizationUrl', 'logoUrl', 'defaultOgImage', 'authorName'] as const) {
    if (typeof input[key] === 'string') result[key] = input[key].trim();
  }
  for (const key of ['titleByLocale', 'descriptionByLocale'] as const) {
    const map = input[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      result[key] = Object.fromEntries(Object.entries(map).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    }
  }
  return result;
}

export function mergeSeoIdentity(value: unknown, previous = '{}'): string {
  const input = typeof value === 'string' ? JSON.parse(value) : value;
  const incoming = normalizeSeoIdentity(input);
  for (const key of ['organizationUrl', 'logoUrl', 'defaultOgImage'] as const) {
    if (incoming[key] && !publicHttpUrl(incoming[key])) throw new Error(`${key} must be an absolute HTTP(S) URL`);
  }
  return JSON.stringify({ ...parseSeoIdentity(previous), ...incoming });
}

/** BCP-47 language detection and Open Graph territory notation are separate contracts. */
export function openGraphLocale(code: string): string | undefined {
  try {
    const locale = new Intl.Locale(code).maximize();
    return locale.region ? `${locale.language}_${locale.region}` : undefined;
  } catch { return undefined; }
}

export function hubUrlsOf(site: LocalePolicySource): Record<string, string> {
  return parseHubUrls(site.hub_urls_json);
}

export function seoIdentityOf(site: LocalePolicySource): SeoIdentity {
  const parsed = parseSeoIdentity(site.seo_identity_json);
  return {
    organizationName: parsed.organizationName || site.name || undefined,
    organizationUrl: publicHttpUrl(parsed.organizationUrl) || originOf(site.product_origin || '') || undefined,
    logoUrl: publicHttpUrl(parsed.logoUrl, site.product_origin || undefined) || undefined,
    defaultOgImage: publicHttpUrl(parsed.defaultOgImage, site.product_origin || undefined) || undefined,
    authorName: parsed.authorName || parsed.organizationName || site.name || undefined,
    titleByLocale: parsed.titleByLocale,
    descriptionByLocale: parsed.descriptionByLocale,
  };
}

export const ARTICLE_REF_PREFIX = 'article:';

export function publicHref(href: string, ctx: PublicHrefContext): string {
  const raw = href.trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:')) return raw;
  if (raw.startsWith(ARTICLE_REF_PREFIX)) {
    // Resolved every render, so a sibling reference starts working the moment
    // that sibling goes live and stops if it is ever unpublished — without
    // republishing the article that points at it. Unresolved, it renders as the
    // anchor text alone rather than as a link into nowhere.
    return ctx.articleUrlsByJob?.[raw.slice(ARTICLE_REF_PREFIX.length).trim()] || '';
  }
  if (/^https?:\/\//i.test(raw)) return raw;
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  if (isBlogPath(ctx.policy, path)) return joinUrl(ctx.origin, path);
  const hub = ctx.hubPath.trim();
  if (hub && (path === hub || path.startsWith(`${hub}#`))) {
    return ctx.hubUrls[ctx.locale] || joinProduct(ctx.productOrigin, hub) || path;
  }
  const product = joinProduct(ctx.productOrigin, path);
  return product || path;
}

function decodePathSegment(value: string): string {
  try { return decodeURIComponent(value); } catch { return ''; }
}

export function matchBlogPath(pathname: string, policy: LocalePolicy): BlogMatch | null {
  const path = stripTrailingSlash(pathname);
  if (path === '/') return { kind: 'home' };
  if (path === '/robots.txt') return { kind: 'robots' };
  if (path === '/sitemap.xml') return { kind: 'sitemap' };
  if (path === '/feed.xml' || path === '/rss.xml' || path === '/atom.xml') return { kind: 'feed' };
  // IndexNow key verification: /{key}.txt where key is 8+ hex chars
  const indexNowKey = /^\/([a-f0-9]{8,})\.txt$/.exec(path);
  if (indexNowKey) return { kind: 'indexnow-key' };
  const sitemapPart = /^\/sitemap-(\d+)\.xml$/.exec(path);
  if (sitemapPart) return { kind: 'sitemap', part: Number(sitemapPart[1]) };
  const first = path.split('/').filter(Boolean)[0] || '';
  const redirected = redirectTargetPrefix(policy, first);
  if (redirected) {
    const rest = path.slice(`/${first}`.length);
    return { kind: 'redirect', pathname: `/${redirected}${rest}` };
  }
  const listPage = /^\/([^/]+)\/blog\/page\/(\d+)$/.exec(path);
  if (listPage) {
    const locale = codeFromPrefix(policy, decodePathSegment(listPage[1]));
    const page = Number(listPage[2]);
    if (!locale || page < 1) return null;
    if (page === 1) return { kind: 'redirect', pathname: listPath(policy, locale, 1) };
    return { kind: 'list', locale, page };
  }
  const list = /^\/([^/]+)\/blog$/.exec(path);
  if (list) {
    const locale = codeFromPrefix(policy, decodePathSegment(list[1]));
    return locale ? { kind: 'list', locale, page: 1 } : null;
  }
  const article = /^\/([^/]+)\/blog\/([^/]+)$/.exec(path);
  if (article) {
    const locale = codeFromPrefix(policy, decodePathSegment(article[1]));
    const slug = decodePathSegment(article[2]);
    if (!locale || !slug) return null;
    return { kind: 'article', locale, slug };
  }
  return null;
}

export function matchLivePath(pathname: string, policy: LocalePolicy): LiveMatch | null {
  const path = stripTrailingSlash(pathname);
  const m = /^\/live\/([^/]+)(?:\/(.*))?$/.exec(path.startsWith('/') ? path : `/${path}`);
  if (!m) return null;
  const siteId = decodeURIComponent(m[1]);
  const rest = m[2] ? `/${m[2]}` : '/';
  const page = matchBlogPath(rest, policy);
  if (!page) return null;
  if (page.kind === 'article') return { kind: 'article', siteId, locale: page.locale, slug: page.slug };
  if (page.kind === 'list') return { kind: 'list', siteId, locale: page.locale, page: page.page };
  if (page.kind === 'robots') return { kind: 'robots', siteId };
  if (page.kind === 'sitemap') return { kind: 'sitemap', siteId, part: page.part };
  if (page.kind === 'feed') return { kind: 'feed', siteId };
  if (page.kind === 'indexnow-key') return { kind: 'indexnow-key', siteId };
  if (page.kind === 'redirect') return { kind: 'redirect', siteId, pathname: page.pathname };
  return { kind: 'home', siteId };
}

/**
 * A hreflang cluster is only honoured when every URL in it points back at the whole set, so the
 * page being rendered has to be a member. A cluster that omits its own URL — a paginated list,
 * whose page 2 has no counterpart in the other locales — is dropped rather than emitted broken:
 * Google discards the entire cluster in that case, which would also lose the pages that were fine.
 */
export function hreflangAlternates(
  pages: Array<{ locale: string; href: string }>,
  defaultCode: string,
  selfHref: string,
): Alternate[] {
  if (!pages.length) return [];
  if (!pages.some((p) => p.href === selfHref)) return [];
  const alternates: Alternate[] = pages.map((p) => ({ hreflang: p.locale, href: p.href }));
  const fallback = pages.find((p) => p.locale === defaultCode) || pages[0];
  alternates.push({ hreflang: 'x-default', href: fallback.href });
  return alternates;
}

/** How many pages `count` items make at `size` per page — always at least 1, even for zero items. */
export function totalPages(count: number, size = LIST_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(count / size));
}

export function paginate<T>(items: T[], page: number, size = LIST_PAGE_SIZE): { items: T[]; page: number; pages: number } {
  const pages = totalPages(items.length, size);
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;
  return { items: items.slice(start, start + size), page: current, pages };
}

export function robotsTxt(origin: string, surface: BlogSurface = 'hosted'): string {
  return robotsTxtFor(joinUrl(origin, '/sitemap.xml'), surface);
}

export type SitemapPage = {
  loc: string;
  lastmod?: string;
  alternates: Alternate[];
};

export function sitemapChunks(pages: SitemapPage[], limit = SITEMAP_URL_LIMIT): SitemapPage[][] {
  if (!pages.length) return [[]];
  const chunks: SitemapPage[][] = [];
  for (let i = 0; i < pages.length; i += limit) chunks.push(pages.slice(i, i + limit));
  return chunks;
}

export function sitemapXml(pages: SitemapPage[]): string {
  const urls = pages
    .map((page) => {
      const links = page.alternates
        .map((a) => `    <xhtml:link rel="alternate" hreflang="${esc(a.hreflang)}" href="${esc(a.href)}"/>`)
        .join('\n');
      const lastmod = page.lastmod ? `    <lastmod>${esc(page.lastmod)}</lastmod>\n` : '';
      return `  <url>\n    <loc>${esc(page.loc)}</loc>\n${lastmod}${links}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
}

export function sitemapIndexXml(origin: string, parts: number): string {
  const items = Array.from({ length: parts }, (_, i) => {
    const loc = joinUrl(origin, `/sitemap-${i + 1}.xml`);
    return `  <sitemap>\n    <loc>${esc(loc)}</loc>\n  </sitemap>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items}
</sitemapindex>
`;
}

export function renderSitemapDocument(origin: string, pages: SitemapPage[], part?: number): string {
  const chunks = sitemapChunks(pages);
  if (chunks.length === 1 && !part) return sitemapXml(chunks[0]);
  if (!part) return sitemapIndexXml(origin, chunks.length);
  const chunk = chunks[part - 1];
  return chunk ? sitemapXml(chunk) : sitemapXml([]);
}

export function blogPostingJsonLd(input: {
  title: string;
  description?: string;
  url: string;
  locale: string;
  datePublished?: string;
  dateModified?: string;
  publisherName: string;
  publisherUrl?: string;
  authorName?: string;
  image?: string;
  logoUrl?: string;
  sameAs?: string[];
}): Record<string, unknown> {
  const publisher: Record<string, unknown> = {
    '@type': 'Organization',
    name: input.publisherName,
    url: input.publisherUrl || undefined,
  };
  if (input.logoUrl) publisher.logo = { '@type': 'ImageObject', url: input.logoUrl };
  if (input.sameAs?.length) publisher.sameAs = input.sameAs;
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: input.title,
    description: input.description || undefined,
    datePublished: input.datePublished || undefined,
    dateModified: input.dateModified || input.datePublished || undefined,
    inLanguage: input.locale,
    url: input.url,
    image: input.image || undefined,
    author: { '@type': 'Organization', name: input.authorName || input.publisherName },
    publisher,
    mainEntityOfPage: { '@type': 'WebPage', '@id': input.url },
  };
}

export function collectionJsonLd(input: {
  title: string;
  url: string;
  locale: string;
  siteName: string;
  siteUrl: string;
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: input.title,
    url: input.url,
    inLanguage: input.locale,
    isPartOf: { '@type': 'WebSite', name: input.siteName, url: input.siteUrl },
  };
}

/**
 * The one entity every page on a site should agree on — same name, same logo, same sameAs set.
 * `sameAs` is the social/profile URLs Google folds into the knowledge-panel identity; omit rather
 * than send an empty array when the site has none on record yet.
 */
export function organizationJsonLd(input: {
  name: string;
  url?: string;
  logoUrl?: string;
  sameAs?: string[];
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: input.name,
    url: input.url || undefined,
    logo: input.logoUrl ? { '@type': 'ImageObject', url: input.logoUrl } : undefined,
    sameAs: input.sameAs?.length ? input.sameAs : undefined,
  };
}

/** Breadcrumbs let the SERP show the blog path instead of a bare URL. */
export function breadcrumbJsonLd(items: Array<{ name: string; url: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function articleHead(input: {
  imageAlt?: string;
  publishedTime?: string;
  modifiedTime?: string;
  title: string;
  description?: string;
  canonical: string;
  locale: string;
  alternates: Alternate[];
  siteName: string;
  image?: string;
  jsonLd?: unknown;
  indexing: IndexDecision;
}): SeoHead {
  return {
    lang: input.locale,
    title: input.title,
    description: input.description,
    canonical: input.canonical,
    robots: robotsDirective(input.indexing),
    alternates: input.alternates,
    ogType: 'article',
    siteName: input.siteName,
    image: input.image,
    imageAlt: input.imageAlt,
    publishedTime: input.publishedTime,
    modifiedTime: input.modifiedTime,
    jsonLd: input.jsonLd,
  };
}

export function listHead(input: {
  image?: string;
  title: string;
  description?: string;
  canonical: string;
  locale: string;
  alternates: Alternate[];
  siteName: string;
  prev?: string;
  next?: string;
  jsonLd?: unknown;
  indexing: IndexDecision;
}): SeoHead {
  return {
    lang: input.locale,
    title: input.title,
    description: input.description,
    canonical: input.canonical,
    robots: robotsDirective(input.indexing),
    alternates: input.alternates,
    ogType: 'website',
    image: input.image,
    siteName: input.siteName,
    prev: input.prev,
    next: input.next,
    jsonLd: input.jsonLd,
  };
}

export function headHtml(head: SeoHead): string {
  const alts = head.alternates
    .map((a) => `<link rel="alternate" hreflang="${esc(a.hreflang)}" href="${esc(a.href)}">`)
    .join('\n');
  const desc = head.description ? `<meta name="description" content="${esc(head.description)}">` : '';
  const robots = `<meta name="robots" content="${esc(head.robots)}">`;
  const ogLocaleAlternates = head.alternates
    .filter((a) => a.hreflang !== 'x-default' && a.hreflang !== head.lang)
    .map((a) => openGraphLocale(a.hreflang))
    .filter((locale): locale is string => !!locale)
    .map((locale) => `<meta property="og:locale:alternate" content="${esc(locale)}">`)
    .join('\n');
  const ogDesc = head.description ? `<meta property="og:description" content="${esc(head.description)}">` : '';
  const ogImage = head.image ? `<meta property="og:image" content="${esc(head.image)}">` : '';
  const twitterImage = head.image ? `<meta name="twitter:image" content="${esc(head.image)}">` : '';
  const prev = head.prev ? `<link rel="prev" href="${esc(head.prev)}">` : '';
  const next = head.next ? `<link rel="next" href="${esc(head.next)}">` : '';
  const jsonLd = head.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(head.jsonLd).replace(/</g, '\\u003c')}</script>`
    : '';
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(head.title)}</title>
${desc}
${robots}
<link rel="canonical" href="${esc(head.canonical)}">
${alts}
${prev}
${next}
<meta property="og:type" content="${esc(head.ogType)}">
<meta property="og:title" content="${esc(head.title)}">
${ogDesc}
<meta property="og:url" content="${esc(head.canonical)}">
<meta property="og:site_name" content="${esc(head.siteName)}">
${openGraphLocale(head.lang) ? `<meta property="og:locale" content="${esc(openGraphLocale(head.lang)!)}">` : ''}
${ogLocaleAlternates}
${ogImage}
${head.image && head.imageAlt ? `<meta property="og:image:alt" content="${esc(head.imageAlt)}">` : ''}
${head.publishedTime ? `<meta property="article:published_time" content="${esc(head.publishedTime)}">` : ''}
${head.modifiedTime ? `<meta property="article:modified_time" content="${esc(head.modifiedTime)}">` : ''}
<meta name="twitter:card" content="${head.image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(head.title)}">
${twitterImage}
${head.description ? `<meta name="twitter:description" content="${esc(head.description)}">` : ''}
${head.image && head.imageAlt ? `<meta name="twitter:image:alt" content="${esc(head.imageAlt)}">` : ''}
${jsonLd}`;
}

export function serializeLocalePolicy(policy: LocalePolicy): string {
  return JSON.stringify({
    default: policy.defaultCode,
    locales: policy.locales,
    redirects: policy.redirects,
  });
}

export function publicLocalePolicy(policy: LocalePolicy) {
  return {
    default_code: policy.defaultCode,
    locales: policy.locales,
    redirects: policy.redirects,
  };
}

function joinProduct(productOrigin: string, path: string): string {
  const product = originOf(productOrigin);
  if (!product) return '';
  return joinUrl(product, path);
}

function absoluteHttpUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/+$/, '') === `${url.protocol}//${url.host}` ? `${url.protocol}//${url.host}` : url.toString();
  } catch {
    return '';
  }
}

function compactRedirects(redirects: LocaleRedirect[], locales: LocaleEntry[]): LocaleRedirect[] {
  const current = new Set(locales.map((l) => l.prefix));
  const out: LocaleRedirect[] = [];
  const seen = new Set<string>();
  for (const red of redirects) {
    if (!red.fromPrefix || !red.toPrefix || red.fromPrefix === red.toPrefix) continue;
    if (!current.has(red.toPrefix)) continue;
    if (current.has(red.fromPrefix)) continue;
    const key = `${red.fromPrefix}->${red.toPrefix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(red);
  }
  return out;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
