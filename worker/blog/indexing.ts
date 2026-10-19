/**
 * The indexability contract every hosted blog shares.
 *
 * Whether a page may enter a search index is decided here and nowhere else; the
 * renderer and the router only carry the decision out. Onboarding another
 * customer site therefore inherits these rules instead of restating them.
 */

/** The same article is reachable from two surfaces; only one of them is the real site. */
export type BlogSurface = 'hosted' | 'preview';

export type IndexBlockReason =
  /** `/live/:siteId/…` duplicates the customer domain, so it must never compete with it. */
  | 'preview_surface'
  /** DNS/TLS check page, not an article. */
  | 'setup_page'
  /** A locale that has no published article yet — an empty page is a thin-content signal. */
  | 'empty_locale'
  | 'not_found';

export type IndexDecision = { indexable: boolean; reason: IndexBlockReason | null };

export const INDEXABLE: IndexDecision = { indexable: true, reason: null };

export function blockedFrom(reason: IndexBlockReason): IndexDecision {
  return { indexable: false, reason };
}

/** The surface wins: nothing served from the preview host is indexable, whatever the page says. */
export function decideIndexing(surface: BlogSurface, page: IndexDecision = INDEXABLE): IndexDecision {
  return surface === 'preview' ? blockedFrom('preview_surface') : page;
}

/**
 * Value for `<meta name="robots">` and the `X-Robots-Tag` header.
 *
 * `follow` is kept even when blocked: a crawler that lands on the preview surface or on a 404
 * should still walk the links out to the canonical pages. On the indexable side the snippet and
 * image limits are opened explicitly — Google's defaults are more conservative in some regions,
 * and a new domain has no reputation to earn a rich result back.
 */
export function robotsDirective(decision: IndexDecision): string {
  return decision.indexable
    ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
    : 'noindex, follow';
}

/** `robots.txt` body. The preview surface disallows everything and advertises no sitemap. */
export function robotsTxtFor(sitemapUrl: string, surface: BlogSurface): string {
  if (surface === 'preview') return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`;
}

/**
 * Response headers carrying the same decision to crawlers that never parse the HTML — a sitemap,
 * a feed, or an HTML response served through a path that bypassed the renderer.
 */
export function crawlerHeaders(surface: BlogSurface): Record<string, string> {
  const decision = decideIndexing(surface);
  return decision.indexable ? {} : { 'X-Robots-Tag': robotsDirective(decision) };
}
