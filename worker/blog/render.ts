import type { ArticleVersion, Job, Site } from '../types';
import { jobVersions } from '../lib/versions';
import { publicHttpUrl } from '../../shared/article-presentation';
import { firstMarkdownImage, markdownToHtml } from './markdown';
import { livePath } from '../db';
import { normalizeBlogLayout, type BlogLayoutKey } from '../../shared/blog-layouts';
import { localeSwitcherCss, localeSwitcherHtml } from './locale-switcher';
import {
  blockedFrom,
  decideIndexing,
  INDEXABLE,
  robotsDirective,
  type BlogSurface,
  type IndexBlockReason,
} from './indexing';
import { organizationNameForLocale, siteNameForLocale } from './site-name';
import {
  articleHead,
  articleUrl,
  blogPostingJsonLd,
  breadcrumbJsonLd,
  collectionJsonLd,
  hreflangAlternates,
  headHtml,
  hubUrlsOf,
  listHead,
  listUrl,
  localePolicyOf,
  matchBlogPath,
  matchLivePath,
  organizationJsonLd,
  originOf,
  paginate,
  publicHref,
  renderSitemapDocument,
  robotsTxt,
  seoIdentityOf,
  type BlogMatch,
  type LocalePolicy,
  type PublicHrefContext,
  type SitemapPage,
} from './seo';

export type { BlogMatch };
export { matchBlogPath, matchLivePath, robotsTxt };
export type { BlogSurface };

export function pathPrefix(siteId: string, hosted: boolean): string {
  return hosted ? '' : livePath(siteId);
}

export function publicOrigin(requestOrigin: string, site: Site, hosted: boolean): string {
  if (hosted && site.domain) return `https://${site.domain}`;
  return `${originOf(requestOrigin)}${pathPrefix(site.id, hosted)}`;
}

export function blogLayoutOf(site: { blog_layout?: string | null }): BlogLayoutKey {
  return normalizeBlogLayout(site.blog_layout);
}

export function publishedVersions(jobs: Job[]): Array<{ job: Job; version: ArticleVersion; siblings: ArticleVersion[] }> {
  const out: Array<{ job: Job; version: ArticleVersion; siblings: ArticleVersion[] }> = [];
  for (const job of jobs) {
    if (job.status !== 'published' || job.visibility === 'hidden') continue;
    const siblings = jobVersions(job);
    for (const version of siblings) out.push({ job, version, siblings });
  }
  return out.sort((left, right) => {
    const published = (right.job.published_at || right.job.created_at)
      .localeCompare(left.job.published_at || left.job.created_at);
    if (published !== 0) return published;
    return right.job.id.localeCompare(left.job.id);
  });
}

export function localesWithContent(jobs: Job[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of publishedVersions(jobs)) {
    if (seen.has(row.version.locale)) continue;
    seen.add(row.version.locale);
    out.push(row.version.locale);
  }
  return out;
}

export function publishedLocalePolicy(site: Site, jobs: Job[]): LocalePolicy {
  return localePolicyOf(site, localesWithContent(jobs));
}

export function findLiveArticle(
  jobs: Job[],
  locale: string,
  slug: string,
): { job: Job; version: ArticleVersion; siblings: ArticleVersion[] } | null {
  return (
    publishedVersions(jobs).find((row) => row.version.locale === locale && row.version.slug === slug) ?? null
  );
}

function hrefCtx(
  origin: string,
  site: Site,
  policy: LocalePolicy,
  locale: string,
  articleUrlsByJob?: Record<string, string>,
): PublicHrefContext {
  return {
    origin,
    productOrigin: site.product_origin || '',
    hubPath: site.hub_path,
    hubUrls: hubUrlsOf(site),
    policy,
    locale,
    articleUrlsByJob,
  };
}

/**
 * Maps each live job to its URL in the locale being read, so `article:<job_id>`
 * resolves to the reader's own language. A job with no version in this locale is
 * left out, and the reference degrades to plain text rather than sending the
 * reader into another language.
 */
export function articleUrlsByJobFor(
  origin: string,
  policy: LocalePolicy,
  locale: string,
  jobs: Job[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { job, version } of publishedVersions(jobs)) {
    if (version.locale !== locale || !version.slug) continue;
    map[job.id] = articleUrl(origin, policy, locale, version.slug);
  }
  return map;
}

function contentDate(job?: Job): string | undefined {
  if (!job) return undefined;
  const dates = [job.published_at, job.content_updated_at].filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
  return dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function publishDate(job: Job): string | undefined {
  return job.published_at || job.created_at || undefined;
}

function dayOf(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

/** Locale-aware display ("August 18, 2026") with the ISO value kept in datetime; falls back to the ISO day. */
function localizedDayHtml(iso: string | undefined, locale: string): string {
  if (!iso) return '';
  const day = dayOf(iso);
  let label = day;
  try {
    label = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso));
  } catch {
    // Unknown locale: keep the ISO day.
  }
  return `<time datetime="${esc(iso)}">${esc(label)}</time>`;
}

/**
 * Same fallback order the console sidebar already uses for a site's icon (`src/components/Shell.tsx`
 * `SiteIcon`): the brand logo when one has been captured, else Google's favicon lookup for the
 * customer's real domain. Never our own — an unbranded generic icon in the SERP and the browser
 * tab is worse than borrowing the customer's existing one.
 *
 * The header mark uses this same chain: most sites never fill in `seo_identity.logoUrl`, and a
 * name-only header reads as unbranded. The customer's favicon is the one brand asset every domain
 * already has.
 */
function brandIconHrefOf(site: Site): string | undefined {
  const logo = seoIdentityOf(site).logoUrl;
  if (logo && /^https?:\/\//i.test(logo)) return logo;
  const host = site.root_domain || site.domain;
  return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64` : undefined;
}

/**
 * Where the blog's one header link points: the customer's own site, not the blog. The blog lives on
 * a subdomain of a domain the customer already owns, so the registrable domain is a safe home even
 * when nobody filled in an organization URL.
 */
export function customerHomeHref(site: Site): string {
  const identity = seoIdentityOf(site);
  const configured = identity.organizationUrl || originOf(site.product_origin || '');
  if (configured && /^https?:\/\//i.test(configured)) return configured;
  const host = site.root_domain.trim();
  return host ? `https://${host}` : '';
}

/**
 * Static shell copy in the site's own language — the footer links plus the article page's way back
 * to its index. Keyed by base language (`zh-CN` and `zh-Hant` both hit `zh`); falls back to English
 * for anything not covered.
 */
const SHELL_LABELS: Record<string, { blogIndex: string; home: string; back: string; summary: string }> = {
  en: { blogIndex: 'All posts', home: 'Home', back: 'Back to blog', summary: 'Summary' },
  zh: { blogIndex: '\u5168\u90e8\u6587\u7ae0', home: '\u9996\u9875', back: '\u8fd4\u56de\u535a\u5ba2', summary: '\u6458\u8981' },
  ja: { blogIndex: 'すべての\u8a18\u4e8b', home: 'ホーム', back: 'ブログに\u623bる', summary: '\u6982\u8981' },
  ko: { blogIndex: '전체 글', home: '홈', back: '블로그로 돌아가기', summary: '요약' },
  es: { blogIndex: 'Todos los artículos', home: 'Inicio', back: 'Volver al blog', summary: 'Resumen' },
  pt: { blogIndex: 'Todos os artigos', home: 'Início', back: 'Voltar ao blog', summary: 'Resumo' },
  fr: { blogIndex: 'Tous les articles', home: 'Accueil', back: 'Retour au blog', summary: 'Résumé' },
  de: { blogIndex: 'Alle Beiträge', home: 'Startseite', back: 'Zurück zum Blog', summary: 'Zusammenfassung' },
  it: { blogIndex: 'Tutti gli articoli', home: 'Home', back: 'Torna al blog', summary: 'Riassunto' },
  ru: { blogIndex: 'Все статьи', home: 'Главная', back: 'Назад в блог', summary: 'Кратко' },
  ar: { blogIndex: 'جميع المقالات', home: 'الرئيسية', back: 'العودة إلى المدونة', summary: 'الملخص' },
  hi: { blogIndex: 'सभी लेख', home: 'होम', back: 'ब्लॉग पर वापस', summary: 'सारांश' },
  vi: { blogIndex: 'Tất cả bài viết', home: 'Trang chủ', back: 'Quay lại blog', summary: 'Tóm tắt' },
  th: { blogIndex: 'บทความทั้งหมด', home: 'หน้าแรก', back: 'กลับไปที่บล็อก', summary: 'สรุป' },
  id: { blogIndex: 'Semua artikel', home: 'Beranda', back: 'Kembali ke blog', summary: 'Ringkasan' },
  tr: { blogIndex: 'Tüm yazılar', home: 'Ana Sayfa', back: 'Bloga dön', summary: 'Özet' },
  nl: { blogIndex: 'Alle berichten', home: 'Home', back: 'Terug naar blog', summary: 'Samenvatting' },
  pl: { blogIndex: 'Wszystkie wpisy', home: 'Strona główna', back: 'Powrót do bloga', summary: 'Streszczenie' },
  sv: { blogIndex: 'Alla inlägg', home: 'Hem', back: 'Tillbaka till bloggen', summary: 'Sammanfattning' },
};

function shellLabels(locale: string): { blogIndex: string; home: string; back: string; summary: string } {
  const base = locale.split('-')[0]?.toLowerCase() || '';
  return SHELL_LABELS[base] || SHELL_LABELS.en;
}

const BACK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>';

/**
 * The article page's own way back to its index, above the title. The footer already links there,
 * but a reader who has just landed on an article from search is at the top of the page, not the
 * bottom — this is the link that keeps them in the blog instead of hitting the browser's Back.
 */
function backLinkHtml(blogHref: string, locale: string): string {
  return `<p class="back-nav"><a href="${esc(blogHref)}">${BACK_ICON}<span>${esc(shellLabels(locale).back)}</span></a></p>`;
}

/**
 * The header is deliberately one link — the customer's logo and name pointing back at their site —
 * plus the locale switcher. We used to rebuild the customer's real nav by copying their DOM, which
 * could never follow the blog past the languages their own site publishes. Owning a small shell we
 * can render in every locale beats owning a faithful one we can only render in theirs.
 */
function shell(
  _origin: string,
  site: Site,
  opts: {
    layout: BlogLayoutKey;
    blogHref: string;
    locale: string;
    navLocales?: Array<{ locale: string; href: string }>;
    trial?: boolean;
  },
): { header: string; footer: string; layoutClass: string } {
  const nav = localeSwitcherHtml(opts.navLocales ?? [], opts.locale);
  const name = siteNameForLocale(site, opts.locale);
  const icon = brandIconHrefOf(site);
  const mark = icon
    ? `<img src="${esc(icon)}" alt="" loading="eager" decoding="async">`
    : '';
  const home = customerHomeHref(site);
  const brand = `${mark}<span>${esc(name)}</span>`;
  const header = `<header class="site-head"><div class="wrap">
<p class="brand">${home ? `<a href="${esc(home)}">${brand}</a>` : brand}</p>
${nav}
</div></header>`;
  const year = new Date().getUTCFullYear();
  const trialNote = opts.trial ? '<span class="sep-dot">·</span><span>Hosting check</span>' : '';
  const labels = shellLabels(opts.locale);
  // The header link leaves for the customer's site, so the footer keeps the way back into the blog
  // itself — otherwise an article would have no internal link to its own index. `home` re-links out
  // to the customer's own domain, same target as the header, for visitors who want to leave the blog.
  const homeLink = home ? `<span class="sep-dot">·</span><a href="${esc(home)}">${esc(labels.home)}</a>` : '';
  // The copyright reuses the header's `name`, not `organizationNameForLocale`: the configured
  // organizationName is a single global string, so on every other locale it printed the brand in a
  // language the page is not written in. Visible copy follows the page's locale; the configured
  // organization name stays where a single canonical entity name belongs — the JSON-LD publisher.
  const footer = `<footer class="site-foot"><div class="wrap">
<p>© ${year} ${esc(name)}</p>
<p class="fine"><a href="${esc(opts.blogHref)}">${esc(labels.blogIndex)}</a>${homeLink}${trialNote}</p>
</div></footer>`;
  return { header, footer, layoutClass: `layout-${opts.layout}` };
}

function localeNav(policy: LocalePolicy, origin: string, present: string[]): Array<{ locale: string; href: string }> {
  const codes = present.length ? present : policy.locales.map((l) => l.code);
  return codes.map((code) => ({ locale: code, href: listUrl(origin, policy, code) }));
}

function articleLocaleNav(
  policy: LocalePolicy,
  origin: string,
  siblings: ArticleVersion[],
  navigationLocales: string[] | undefined,
): Array<{ locale: string; href: string }> {
  const translated = new Map(siblings.map((version) => [version.locale, version]));
  const codes = navigationLocales?.length
    ? navigationLocales
    : siblings.map((version) => version.locale);
  return [...new Set(codes)]
    .filter((code) => policy.locales.some((locale) => locale.code === code))
    .map((code) => {
      const translation = translated.get(code);
      return {
        locale: code,
        href: translation
          ? articleUrl(origin, policy, code, translation.slug)
          : listUrl(origin, policy, code),
      };
    });
}

export function renderTrialHtml(origin: string, site: Site): string {
  const policy = localePolicyOf(site);
  const identity = seoIdentityOf(site);
  const layoutKey = blogLayoutOf(site);
  const home = `${originOf(origin)}/`;
  const title = identity.titleByLocale?.[policy.defaultCode] || siteNameForLocale(site, policy.defaultCode);
  const description = identity.descriptionByLocale?.[policy.defaultCode] || '';
  const empty = '<div class="placeholder-card">The first article is on its way. It will appear here once published.</div>';
  const localizedName = siteNameForLocale(site, policy.defaultCode);
  const s = shell(origin, site, {
    layout: layoutKey,
    blogHref: home,
    locale: policy.defaultCode,
    navLocales: localeNav(policy, origin, []),
    trial: true,
  });
  return layout({
    siteId: site.id,
    faviconUrl: brandIconHrefOf(site),
    gscVerificationMetaToken: site.gsc_verification_meta_token,
    feedUrl: `${originOf(origin)}/feed.xml`,
    shell: s,
    head: {
      lang: policy.defaultCode,
      title,
      description: description || 'Temporary hosting check. Not an article.',
      canonical: home,
      robots: robotsDirective(blockedFrom('setup_page')),
      alternates: [],
      ogType: 'website',
      siteName: localizedName,
    },
    body: `<section class="hero-block">
<h1>${esc(title)}</h1>
${description ? `<p class="lead">${esc(description)}</p>` : ''}
</section>
${empty}
<p class="fine">Hosting check — DNS and TLS are working on ${esc(site.domain || localizedName)}. This page is temporary, not an article.</p>`,
  });
}

export function renderListHtml(
  origin: string,
  site: Site,
  jobs: Job[],
  locale: string,
  page = 1,
  opts: { surface?: BlogSurface } = {},
): string {
  const policy = publishedLocalePolicy(site, jobs);
  const identity = seoIdentityOf(site);
  const layoutKey = blogLayoutOf(site);
  const present = localesWithContent(jobs);
  const rows = publishedVersions(jobs).filter((row) => row.version.locale === locale);
  const empty = rows.length === 0;
  const localizedName = siteNameForLocale(site, locale);
  const items = rows.map((row) =>
    magazineCardHtml(policy, origin, row, page === 1 && row === rows[0], localizedName),
  );
  const sliced = paginate(items, page);
  const canonical = listUrl(origin, policy, locale, sliced.page);
  const liveLocales = present.filter((code) => policy.locales.some((l) => l.code === code));
  // Page 2+ has no counterpart in the other locales (their article counts differ), so the cluster
  // guard drops hreflang there and the page carries only its self-canonical.
  const alternates = empty
    ? []
    : hreflangAlternates(
        liveLocales.map((code) => ({ locale: code, href: listUrl(origin, policy, code) })),
        policy.defaultCode,
        canonical,
      );
  const indexing = decideIndexing(opts.surface ?? 'hosted', empty ? blockedFrom('empty_locale') : INDEXABLE);
  const title = identity.titleByLocale?.[locale] || localizedName;
  const description = identity.descriptionByLocale?.[locale] || localizedName;
  const leadHtml = identity.descriptionByLocale?.[locale]
    ? `<p class="list-lead">${esc(identity.descriptionByLocale[locale])}</p>`
    : '';
  const listHeader = `<p class="eyebrow">Blog</p>\n<h1>${esc(title)}</h1>${leadHtml}`;
  const s = shell(origin, site, {
    layout: layoutKey,
    blogHref: listUrl(origin, policy, policy.defaultCode),
    locale,
    navLocales: localeNav(policy, origin, liveLocales),
  });
  const emptyBlock = '<div class="placeholder-card">No published articles in this language yet.</div>';
  return layout({
    siteId: site.id,
    faviconUrl: brandIconHrefOf(site),
    gscVerificationMetaToken: site.gsc_verification_meta_token,
    feedUrl: `${originOf(origin)}/feed.xml`,
    shell: s,
    head: listHead({
      image: identity.defaultOgImage,
      title,
      description,
      canonical,
      locale,
      alternates,
      siteName: localizedName,
      prev: sliced.page > 1 ? listUrl(origin, policy, locale, sliced.page - 1) : undefined,
      next: sliced.page < sliced.pages ? listUrl(origin, policy, locale, sliced.page + 1) : undefined,
      // Deeper pages stay indexable on purpose: noindex is eventually treated as nofollow, which
      // would cut every article past the first page off from internal linking.
      indexing,
      jsonLd: empty
        ? undefined
        : [
            collectionJsonLd({
              title,
              url: canonical,
              locale,
              siteName: localizedName,
              siteUrl: originOf(origin),
            }),
            organizationJsonLd({
              name: organizationNameForLocale(site, locale),
              url: identity.organizationUrl || originOf(site.product_origin) || originOf(origin),
              logoUrl: identity.logoUrl,
            }),
          ],
    }),
    body: `${listHeader}
${empty ? emptyBlock : `<ul class="posts magazine">${sliced.items.join('\n')}</ul>`}
${paginateNav(origin, policy, locale, sliced)}`,
  });
}

/** "METHOD" -> "Method", "seo_geo" -> "Seo geo"; null/empty stays empty. */
function categoryLabel(category: string | null): string {
  const raw = (category || '').trim();
  if (!raw) return '';
  return raw
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

const ARROW_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 11.5 11.5 4.5M5.5 4.5h6v6"/></svg>';

function magazineCardHtml(
  policy: LocalePolicy,
  origin: string,
  row: { job: Job; version: ArticleVersion },
  featured: boolean,
  siteName: string,
): string {
  const href = articleUrl(origin, policy, row.version.locale, row.version.slug);
  const tag = categoryLabel(row.job.category);
  const initial = (siteName.trim().charAt(0) || '·').toUpperCase();
  return `<li class="post-card${featured ? ' featured' : ''}"><div class="post-top">${
    tag ? `<span class="post-tag">${esc(tag)}</span>` : ''
  }<span class="post-arrow">${ARROW_ICON}</span></div><h2 class="post-title"><a href="${esc(href)}">${esc(
    row.version.title,
  )}</a></h2><div class="post-meta"><span class="post-avatar" aria-hidden="true">${esc(initial)}</span>${localizedDayHtml(
    publishDate(row.job),
    row.version.locale,
  )}</div></li>`;
}

function paginateNav(
  origin: string,
  policy: LocalePolicy,
  locale: string,
  sliced: { page: number; pages: number },
): string {
  if (sliced.pages <= 1) return '';
  const parts: string[] = [];
  if (sliced.page > 1) parts.push(`<a class="pager" href="${esc(listUrl(origin, policy, locale, sliced.page - 1))}">← Newer</a>`);
  parts.push(`<span class="pager-note">Page ${sliced.page} / ${sliced.pages}</span>`);
  if (sliced.page < sliced.pages) parts.push(`<a class="pager" href="${esc(listUrl(origin, policy, locale, sliced.page + 1))}">Older →</a>`);
  return `<nav class="pager-nav">${parts.join('')}</nav>`;
}

export function renderArticleHtml(
  origin: string,
  site: Site,
  hit: { job?: Job; version: ArticleVersion; siblings: ArticleVersion[] },
  opts: {
    blocked?: IndexBlockReason;
    policy?: LocalePolicy;
    navigationLocales?: string[];
    surface?: BlogSurface;
    articleUrlsByJob?: Record<string, string>;
  } = {},
): string {
  const policy = opts.policy ?? localePolicyOf(site, hit.siblings.map((version) => version.locale));
  const identity = seoIdentityOf(site);
  const layoutKey = blogLayoutOf(site);
  const { version, siblings, job } = hit;
  const canonical = articleUrl(origin, policy, version.locale, version.slug);
  const pages = siblings.map((v) => ({ locale: v.locale, href: articleUrl(origin, policy, v.locale, v.slug) }));
  const alternates = hreflangAlternates(pages, policy.defaultCode, canonical);
  const indexing = decideIndexing(
    opts.surface ?? 'hosted',
    opts.blocked ? blockedFrom(opts.blocked) : INDEXABLE,
  );
  const publisherUrl = identity.organizationUrl || originOf(site.product_origin) || originOf(origin);
  const ctx = hrefCtx(origin, site, policy, version.locale, opts.articleUrlsByJob);
  const rewrite = (href: string) => publicHref(href, ctx);
  const publishedAt = job?.published_at || undefined;
  const modifiedAt = contentDate(job);
  const bodyImage = firstMarkdownImage(version.content);
  const image = publicHttpUrl(version.image_url) || bodyImage?.url || identity.defaultOgImage;
  const imageAlt = version.image_url ? version.image_alt : bodyImage?.alt;
  const description = (version.meta_description || version.excerpt.split(/\n\s*\n/)[0] || version.title).replace(/\s+/g, ' ').trim();
  const localizedName = siteNameForLocale(site, version.locale);
  const s = shell(origin, site, {
    layout: layoutKey,
    blogHref: listUrl(origin, policy, version.locale),
    locale: version.locale,
    navLocales: articleLocaleNav(policy, origin, siblings, opts.navigationLocales),
  });
  return layout({
    siteId: site.id,
    faviconUrl: brandIconHrefOf(site),
    gscVerificationMetaToken: site.gsc_verification_meta_token,
    feedUrl: `${originOf(origin)}/feed.xml`,
    shell: s,
    head: articleHead({
      publishedTime: publishedAt,
      modifiedTime: modifiedAt,
      imageAlt,
      title: version.title,
      description,
      canonical,
      locale: version.locale,
      alternates,
      siteName: localizedName,
      image,
      indexing,
      jsonLd: indexing.indexable
        ? [
            blogPostingJsonLd({
              title: version.title,
              description: version.excerpt,
              url: canonical,
              locale: version.locale,
              datePublished: publishedAt,
              dateModified: modifiedAt,
              publisherName: organizationNameForLocale(site, version.locale),
              publisherUrl,
              authorName: identity.authorName,
              image,
              logoUrl: identity.logoUrl,
            }),
            breadcrumbJsonLd([
              { name: localizedName, url: listUrl(origin, policy, version.locale) },
              { name: version.title, url: canonical },
            ]),
          ]
        : undefined,
    }),
    body: `${backLinkHtml(listUrl(origin, policy, version.locale), version.locale)}
<article>
  <h1 class="article-title">${esc(version.title)}</h1>
  ${publishedAt ? `<p class="excerpt">${localizedDayHtml(publishedAt, version.locale)}</p>` : ''}
  ${version.excerpt ? `<section class="article-summary"><p class="summary-label">${esc(shellLabels(version.locale).summary)}</p><p class="excerpt">${esc(version.excerpt)}</p></section>` : ''}
  ${publicHttpUrl(version.image_url) ? `<figure><img src="${esc(publicHttpUrl(version.image_url))}" alt="${esc(version.image_alt || '')}" fetchpriority="high" decoding="async"></figure>` : ''}
  ${markdownToHtml(version.content, rewrite)}
</article>`,
  });
}

export function sitemapPages(origin: string, site: Site, jobs: Job[]): SitemapPage[] {
  const policy = publishedLocalePolicy(site, jobs);
  const present = localesWithContent(jobs);
  const published = publishedVersions(jobs);
  const articles = published.map((row) => ({
    loc: articleUrl(origin, policy, row.version.locale, row.version.slug),
    lastmod: (contentDate(row.job) || '').slice(0, 10) || undefined,
    alternates: hreflangAlternates(
      row.siblings.map((v) => ({ locale: v.locale, href: articleUrl(origin, policy, v.locale, v.slug) })),
      policy.defaultCode,
      articleUrl(origin, policy, row.version.locale, row.version.slug),
    ),
  }));
  const lists = present.map((code) => ({
    loc: listUrl(origin, policy, code),
    lastmod: published
      .filter((row) => row.version.locale === code)
      .map((row) => contentDate(row.job) || '')
      .filter(Boolean)
      .sort()
      .at(-1)
      ?.slice(0, 10),
    alternates: hreflangAlternates(
      present.map((x) => ({ locale: x, href: listUrl(origin, policy, x) })),
      policy.defaultCode,
      listUrl(origin, policy, code),
    ),
  }));
  return [...lists, ...articles];
}

export function renderSitemapXml(origin: string, site: Site, jobs: Job[], part?: number): string {
  return renderSitemapDocument(origin, sitemapPages(origin, site, jobs), part);
}

export function renderFeedXml(origin: string, site: Site, jobs: Job[]): string {
  const policy = publishedLocalePolicy(site, jobs);
  const rows = publishedVersions(jobs).slice(0, 50); // latest 50 entries
  const items = rows.map((row) => {
    const url = articleUrl(origin, policy, row.version.locale, row.version.slug);
    const pubDate = row.job.published_at || row.job.created_at;
    return `  <item>
    <title>${esc(row.version.title)}</title>
    <link>${esc(url)}</link>
    <guid isPermaLink="true">${esc(url)}</guid>
    <description>${esc(row.version.excerpt)}</description>
    <pubDate>${new Date(pubDate).toUTCString()}</pubDate>
  </item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${esc(site.name)}</title>
  <link>${esc(origin)}</link>
  <description>${esc(site.name)}</description>
  <atom:link href="${esc(origin)}/feed.xml" rel="self" type="application/rss+xml"/>
${items.join('\n')}
</channel>
</rss>`;
}

export function renderNotFoundHtml(
  origin: string,
  site: Site,
  opts: { policy?: LocalePolicy; navigationLocales?: string[] } = {},
): string {
  const policy = opts.policy ?? localePolicyOf(site);
  const s = shell(origin, site, {
    layout: blogLayoutOf(site),
    blogHref: `${originOf(origin)}/`,
    locale: policy.defaultCode,
    navLocales: localeNav(policy, origin, opts.navigationLocales ?? []),
  });
  return layout({
    siteId: site.id,
    faviconUrl: brandIconHrefOf(site),
    gscVerificationMetaToken: site.gsc_verification_meta_token,
    shell: s,
    head: {
      lang: policy.defaultCode,
      title: 'Not found',
      canonical: originOf(origin) + '/',
      robots: robotsDirective(blockedFrom('not_found')),
      alternates: [],
      ogType: 'website',
      siteName: siteNameForLocale(site, policy.defaultCode),
    },
    body: `<h1>Not found</h1>
<p class="empty-note">This page is not published.</p>`,
  });
}

function layout(opts: {
  siteId?: string;
  faviconUrl?: string;
  gscVerificationMetaToken?: string;
  feedUrl?: string;
  shell?: { header: string; footer: string; layoutClass: string };
  head: Parameters<typeof headHtml>[0];
  body: string;
}): string {
  const siteMeta = opts.siteId ? `<meta name="blog-agent-site" content="${esc(opts.siteId)}">` : '';
  const faviconLink = opts.faviconUrl ? `<link rel="icon" href="${esc(opts.faviconUrl)}">` : '';
  const gscMeta = opts.gscVerificationMetaToken
    ? `<meta name="google-site-verification" content="${esc(opts.gscVerificationMetaToken)}" />`
    : '';
  const feedLink = opts.feedUrl
    ? `<link rel="alternate" type="application/rss+xml" title="${esc(opts.head.siteName)}" href="${esc(opts.feedUrl)}">`
    : '';
  const shellClass = opts.shell?.layoutClass ?? 'layout-magazine';
  return `<!doctype html>
<html lang="${esc(opts.head.lang)}">
<head>
${headHtml(opts.head)}
${faviconLink}
${gscMeta}
${feedLink}
${siteMeta}
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1a1a1a; background: #fff; display: flex; flex-direction: column; min-height: 100vh; }
  .wrap { width: 100%; max-width: 42rem; margin: 0 auto; padding-left: 1.25rem; padding-right: 1.25rem; }
  body.layout-magazine main.wrap { max-width: 72rem; padding-top: 5rem; padding-bottom: 6rem; }
  main.wrap { flex: 1; padding-top: 2.25rem; padding-bottom: 4rem; }
  h1, h2, h3 { line-height: 1.25; }
  a { color: inherit; }
  pre { overflow-x: auto; background: #f6f6f6; border-radius: 8px; padding: 1rem; line-height: 1.5; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  pre code { font-size: .875rem; }
  main.wrap :not(pre) > code { background: #f1f1f1; border-radius: 4px; padding: .1em .35em; }
  article img { display: block; max-width: 100%; height: auto; border-radius: .5rem; }
  article figure { margin: 1.5rem 0; }
  article blockquote { margin: 1.5rem 0; padding: .5rem 1.25rem; border-left: 3px solid #b5b5b5; }
  article h2, article h3, article h4, article h5, article h6 { scroll-margin-top: 2rem; overflow-wrap: anywhere; }
  article table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; font-size: .95rem; display: block; overflow-x: auto; }
  article th, article td { border: 1px solid #e2e2e2; padding: .55rem .75rem; text-align: left; vertical-align: top; }
  article th { background: #f6f6f6; font-weight: 600; }
  article tbody tr:nth-child(even) { background: #fafafa; }
  article hr { border: 0; border-top: 1px solid #e2e2e2; margin: 2.25rem auto; width: 6rem; }
  .site-head { border-bottom: 1px solid #ececec; }
  /* The shell frames the content column instead of sitting inside it: brand and locale switcher
     line up 4rem outside the article grid's edges, not somewhere in the middle of it. */
  .site-head .wrap, .site-foot .wrap { max-width: 80rem; }
  .site-head .wrap { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-top: 1rem; padding-bottom: 1rem; }
  .brand { margin: 0; font-weight: 600; }
  .brand a { display: inline-flex; align-items: center; gap: .5rem; text-decoration: none; }
  .brand img { display: block; width: auto; height: 1.75rem; max-width: 11rem; object-fit: contain; border-radius: 6px; }
  .site-nav { display: flex; gap: .8rem; font-size: .85rem; }
  .site-nav a { color: #6b6b6b; text-decoration: none; }
  .site-nav a.langs-cur { color: #1a1a1a; font-weight: 600; }
  .site-foot { border-top: 1px solid #ececec; }
  .site-foot .wrap { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding-top: 1.25rem; padding-bottom: 2rem; font-size: .85rem; color: #6b6b6b; }
  .site-foot p { margin: 0; }
  .site-foot a { color: #6b6b6b; }
  .sep-dot { margin: 0 .45rem; color: #c9c9c9; }
  .excerpt, .fine, .empty-note, .pager-note { color: #6b6b6b; font-size: .9rem; }
  h1 { font-size: 1.9rem; margin: 0 0 .6rem; }
  /* The 22ch cap is an editorial choice for the magazine index h1; an article headline reads better
     filling the whole content column and wrapping naturally. */
  body.layout-magazine h1.article-title { max-width: none; }
  .article-summary { margin-top: 2rem; }
  .summary-label { margin: 0 0 .4rem; font-size: .75rem; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: #a3a29d; }
  .hero-block { margin-bottom: 1.25rem; }
  .lead { color: #6b6b6b; font-size: 1.05rem; margin: 0; max-width: 46ch; }
  .posts { padding: 0; list-style: none; margin: 1.5rem 0 0; }
  .posts a { font-weight: 500; text-decoration: none; }
  .posts a:hover { text-decoration: underline; }
  time { color: #6b6b6b; font-size: .85rem; }
  .eyebrow { margin: 0; font-size: .875rem; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: rgba(23, 23, 23, .62); }
  body.layout-magazine { background: #f2f1ee; }
  body.layout-magazine h1 { font-size: clamp(2.25rem, 5vw, 3.75rem); line-height: 1.06; letter-spacing: -.025em; margin: 1rem 0 0; max-width: 22ch; }
  body.layout-magazine .list-lead { margin: 1.25rem 0 0; font-size: 1.125rem; line-height: 1.6; color: #6f6e69; max-width: 36rem; }
  body.layout-magazine .posts { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; margin-top: 3.5rem; }
  body.layout-magazine .posts li { background: #fff; border: 0; border-radius: 1rem; padding: 1.5rem; display: flex; flex-direction: column; min-height: 17rem; }
  body.layout-magazine .post-top { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; }
  body.layout-magazine .post-tag { display: inline-block; background: #f1f0ee; color: #6f6e69; border-radius: 999px; padding: .25rem .625rem; font-size: .6875rem; font-weight: 600; line-height: 1.5; }
  body.layout-magazine .post-arrow { flex: none; width: 2.5rem; height: 2.5rem; border: 1px solid #e7e6e2; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #171717; }
  body.layout-magazine .post-arrow svg { width: .875rem; height: .875rem; }
  body.layout-magazine .post-title { margin: auto 0 1.25rem; padding-top: 1.5rem; font-size: 1.25rem; line-height: 1.18; font-weight: 700; letter-spacing: -.01em; }
  body.layout-magazine .post-title a { text-decoration: none; }
  body.layout-magazine .post-title a:hover { text-decoration: underline; }
  body.layout-magazine .posts li.featured .post-title { font-size: clamp(1.75rem, 3vw, 2.25rem); line-height: 1.15; letter-spacing: -.02em; }
  body.layout-magazine .post-meta { display: flex; align-items: center; gap: .5rem; margin-top: auto; padding-top: .9rem; border-top: 1px solid #eceae5; font-size: .6875rem; color: #a3a29d; }
  body.layout-magazine .post-avatar { flex: none; width: 1.5rem; height: 1.5rem; border-radius: 50%; background: #171717; color: #fff; font-size: .625rem; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
  body.layout-magazine .post-meta time { font-size: .6875rem; color: #a3a29d; }
  .placeholder-card { border: 1.5px dashed #d9d9d9; border-radius: 12px; padding: 2.2rem 1.5rem; text-align: center; color: #6b6b6b; margin-top: 1.5rem; }
  .pager-nav { display: flex; align-items: center; gap: 1rem; margin-top: 1.75rem; }
  .pager { text-decoration: none; color: #1a1a1a; font-weight: 500; }
  .back-nav { margin: 0 0 1rem; font-size: .875rem; }
  .back-nav a { display: inline-flex; align-items: center; gap: .4rem; color: #6b6b6b; text-decoration: none; }
  .back-nav a:hover { color: #1a1a1a; }
  .back-nav svg { width: .875rem; height: .875rem; flex: none; }
  /* The magazine h1 already carries a 1rem top margin, so the link only needs to clear itself. */
  body.layout-magazine .back-nav { margin-bottom: 0; color: #6f6e69; }
  body.layout-magazine .back-nav a { color: #6f6e69; }
  body.layout-magazine .back-nav a:hover { color: #171717; }
${localeSwitcherCss}
  @media (max-width: 640px) {
    body.layout-magazine main.wrap { padding-top: 3rem; }
    body.layout-magazine .posts { grid-template-columns: 1fr; margin-top: 2.5rem; }
    body.layout-magazine .posts li { min-height: 0; }
    body.layout-magazine .posts li.featured .post-title { font-size: 1.5rem; }
    .site-head .wrap { flex-direction: column; align-items: flex-start; gap: .3rem; }
    h1 { font-size: 1.55rem; }
  }
</style>
</head>
<body class="${esc(shellClass)}">
${opts.shell?.header ?? ''}
<main class="wrap">
${opts.body}
</main>
${opts.shell?.footer ?? ''}
</body>
</html>`;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
