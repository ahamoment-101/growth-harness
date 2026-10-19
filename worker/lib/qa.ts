import { articlePresentationPatch, publicHttpUrl } from '../../shared/article-presentation';
import { ARTICLE_REF_PREFIX } from '../blog/seo';
import type { ArticleVersion } from '../types';

export type QaIssue = { code: string; message: string };
export type QaReport = { ok: boolean; issues: QaIssue[] };

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type QaInput = {
  versions: ArticleVersion[];
  locales: string[];
  hub_path: string;
  /** Per-locale absolute hub URLs from the site, when configured. A link that
   * already points at one of these is correct as written. */
  hub_urls?: Record<string, string>;
  /** Origin the blog is served from, used to tell an internal link from an
   * outbound one. */
  blog_origin?: string;
  /** The customer's product origin, used to recognise the hub written as an
   * absolute URL without a locale prefix. */
  product_origin?: string;
  /** Live URLs of articles that already exist. An internal link must land on one
   * of these; anything else pointing into the blog is a URL the writer composed
   * from a keyword, which publishes as a dead link. */
  known_article_urls?: string[];
  /** Job ids the article may reference with `article:<id>`, covering both
   * published articles and siblings in the same group that have no slug yet. */
  known_article_refs?: string[];
};

export { ARTICLE_REF_PREFIX };

/** A live article an internal link may land on, in one locale. */
export type LinkableArticle = { job_id: string; locale: string; title: string; url: string };
type SiteLinkFacts = Pick<QaInput, 'hub_path' | 'hub_urls' | 'product_origin' | 'blog_origin'>;

/**
 * Every publication gate — the writer's submission and the human approval —
 * must judge links against the same site facts and the same article names, or
 * an article accepted at one gate is rejected at the next. They derive them here.
 */
export function siteLinkFacts(site: Record<string, unknown>): Required<SiteLinkFacts> {
  let hubUrls: Record<string, string> = {};
  try { hubUrls = JSON.parse(String(site.hub_urls_json || '{}')) as Record<string, string>; } catch { /* No configured hub URLs. */ }
  return {
    hub_path: String(site.hub_path || '/'),
    hub_urls: hubUrls,
    product_origin: String(site.product_origin || ''),
    blog_origin: site.domain && site.domain_status === 'live' ? `https://${String(site.domain)}` : '',
  };
}

export function linkableArticles(jobs: Array<Record<string, unknown>>, blogOrigin: string): LinkableArticle[] {
  return jobs.flatMap((job) => {
    let versions: ArticleVersion[] = [];
    try { versions = JSON.parse(String(job.versions_json || '[]')) as ArticleVersion[]; } catch { /* No readable versions. */ }
    return versions.map((version) => ({
      job_id: String(job.id), locale: version.locale, title: version.title,
      url: `${blogOrigin}/${version.locale}/blog/${version.slug}`,
    }));
  });
}

/** Siblings have no URL while they are written, so they are named only by job id. */
export function articleLinkQaInput(facts: SiteLinkFacts, published: LinkableArticle[], siblingJobIds: string[]): Omit<QaInput, 'versions' | 'locales'> {
  return {
    hub_path: facts.hub_path, hub_urls: facts.hub_urls, product_origin: facts.product_origin, blog_origin: facts.blog_origin,
    known_article_urls: published.map((article) => article.url),
    known_article_refs: [...published.map((article) => article.job_id), ...siblingJobIds],
  };
}

export function runQa(input: QaInput): QaReport {
  const issues: QaIssue[] = [];
  const byLocale = new Map(input.versions.map((v) => [v.locale, v]));
  const locales = input.locales.length > 0 ? input.locales : input.versions.map((v) => v.locale);

  for (const locale of locales) {
    const version = byLocale.get(locale);
    if (!version?.slug || !version.title || !version.content) {
      issues.push({ code: `missing_${locale}`, message: `${locale}: slug, title and content are required` });
      continue;
    }
    if (!SLUG_RE.test(version.slug)) {
      issues.push({ code: `${locale}_slug`, message: `${locale} slug must be lowercase kebab-case` });
    }
    try { articlePresentationPatch(version as unknown as Record<string, unknown>); }
    catch (error) { issues.push({ code: `${locale}_metadata`, message: error instanceof Error ? error.message : 'Invalid metadata' }); }
    issues.push(...markdownSubsetIssues(locale, version.content));
    issues.push(...internalLinkIssues(locale, version.content, input));

  }

  const slugs = locales.map((locale) => byLocale.get(locale)?.slug).filter(Boolean) as string[];
  if (new Set(slugs).size !== slugs.length) {
    issues.push({ code: 'slug_same', message: 'Each locale must have a distinct slug' });
  }

  return { ok: issues.length === 0, issues };
}

export function wordCount(text: string): number {
  const latinWords = text
    .replace(/[#*`\[\]()>-]/g, ' ')
    .split(/\s+/)
    .filter((w) => /[A-Za-z]/.test(w)).length;
  const cjkCharacters = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  return latinWords + Math.ceil(cjkCharacters / 2);
}

function normalizeHref(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Internal links must point at an article that exists.
 *
 * Nothing checked this before, and the renderer only inspects a link's *shape* —
 * `/en/blog/anything` looks like an article whether or not one is there — so a
 * URL assembled out of a keyword publishes as a dead link. That is not
 * hypothetical: a sub-Agent wrote `/pt/blog/escrever-em-ingles-sem-tradutor`
 * from a sibling's keyword while that sibling was still being written by another
 * sub-Agent, and no slug like it existed or would exist.
 *
 * Siblings are the reason `article:<job_id>` exists at all. A group is written in
 * parallel, so at writing time no one knows anyone else's slug — the only stable
 * name for "that article" is its job id, resolved to a URL when the page renders.
 */
function looksLikeBlogArticle(href: string, blogOrigin: string): boolean {
  const value = href.trim().toLowerCase();
  if (!value) return false;
  if (value.startsWith('/')) return value.includes('/blog/');
  const origin = blogOrigin.trim().toLowerCase().replace(/\/+$/, '');
  return Boolean(origin) && value.startsWith(origin) && value.includes('/blog/');
}

function internalLinkIssues(label: string, content: string, input: QaInput): QaIssue[] {
  const issues: QaIssue[] = [];
  const knownUrls = new Set((input.known_article_urls || []).map(normalizeHref));
  const knownRefs = new Set((input.known_article_refs || []).map((ref) => ref.trim()));
  const blogOrigin = input.blog_origin || '';
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(content)) !== null) {
    const raw = m[2].trim().split(/\s+/, 1)[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (raw.startsWith(ARTICLE_REF_PREFIX)) {
      const ref = raw.slice(ARTICLE_REF_PREFIX.length).trim();
      if (!knownRefs.has(ref)) {
        issues.push({
          code: `${label}_unknown_article_ref`,
          message: `${label}: ${raw} does not name an article you may link to. Use read_published_articles for live articles, or the job_id of a sibling listed in this group; do not invent one.`,
        });
      }
      continue;
    }
    if (!looksLikeBlogArticle(raw, blogOrigin)) continue;
    const href = normalizeHref(raw.split('#', 1)[0].split('?', 1)[0]);
    if (knownUrls.has(href)) continue;
    issues.push({
      code: `${label}_dead_internal_link`,
      message: `${label}: ${raw} is not a published article on this blog, so it would publish as a dead link. Link only to a url returned by read_published_articles, or reference a sibling in this group as [anchor](${ARTICLE_REF_PREFIX}<job_id>) — never build a blog URL out of a keyword.`,
    });
  }
  return issues;
}

export function markdownSubsetIssues(label: string, content: string): QaIssue[] {
  const issues: QaIssue[] = [];
  const lines = content.split('\n');

  const fenceCount = (content.match(/^```/gm) || []).length;
  if (fenceCount % 2 !== 0) {
    issues.push({ code: `${label}_fence_unclosed`, message: `${label}: fenced code block is not closed` });
  }
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const match of trimmed.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      if (!publicHttpUrl(match[1])) issues.push({ code: `${label}_image_url`, message: `${label}: images require an absolute HTTP(S) URL` });
    }
    if (/^#{7,}\s+/.test(trimmed)) {
      issues.push({ code: `${label}_heading`, message: `${label} line ${i + 1}: HTML supports headings through H6` });
    }
  }

  return issues;
}
