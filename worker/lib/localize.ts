import type { ArticleVersion, Job, Site } from '../types';
import { ARTICLE_MARKDOWN_CAPABILITIES } from '../../shared/article-presentation';
import { ARTICLE_REF_PREFIX } from '../blog/seo';
import { nextArticleAliases, ownsArticleUrl } from '../blog/url-history';
import type { QaReport } from './qa';
import { jobVersions, versionsPatch } from './versions';
import { generationLocales, jobGenerationLocales } from './webhook';
import { requestModelText } from './model-request';
import type { ResolvedModelProfile } from '../agent-runtime/model-registry';

/**
 * Localizing a published article: one model call per missing locale turns the
 * approved source version into a market-adapted version of the same article,
 * which then goes live next to the source (the human already approved the source).
 *
 * Internal article links need no rewriting. They are stored as `article:<job_id>`
 * and resolved per reader locale at render time, so the model only has to keep
 * every link target exactly as written; the check below enforces that.
 */

export type LocalizationStatus = 'running' | 'failed' | 'done';

export type LocalizationRow = {
  id: string;
  site_id: string;
  job_id: string;
  locale: string;
  status: LocalizationStatus;
  workflow_id: string;
  error: string;
  created_at: string;
  updated_at: string;
};

/** A run that never reported back (lost instance) may be started again after this. */
export const STALE_RUNNING_MS = 30 * 60_000;

/** Site languages this article has no version in yet. */
export function missingLocales(job: Job, site: Site): string[] {
  const present = new Set(jobVersions(job).map((version) => version.locale.toLowerCase()));
  return generationLocales(site).filter((locale) => !present.has(locale.toLowerCase()));
}

export type LocalizationView = {
  /** Site languages still without a version; a running language is not counted as missing. */
  missing_locales: string[];
  items: Array<Pick<LocalizationRow, 'locale' | 'status' | 'error' | 'updated_at'>>;
};

/** What the console shows for one published article: languages to fill and runs in flight or failed. */
export function localizationView(job: Job, site: Site, rows: LocalizationRow[], now = new Date()): LocalizationView {
  const staleBefore = now.getTime() - STALE_RUNNING_MS;
  const present = new Set(jobVersions(job).map((version) => version.locale.toLowerCase()));
  const items = rows
    .filter((row) => row.job_id === job.id && row.status !== 'done' && !present.has(row.locale.toLowerCase()))
    .map((row) => (row.status === 'running' && Date.parse(row.updated_at) < staleBefore
      ? { ...row, status: 'failed' as const, error: row.error || 'Localization has not completed for a long time; you can start it again' }
      : row))
    .map(({ locale, status, error, updated_at }) => ({ locale, status, error, updated_at }));
  const running = new Set(items.filter((item) => item.status === 'running').map((item) => item.locale.toLowerCase()));
  return {
    missing_locales: missingLocales(job, site).filter((locale) => !running.has(locale.toLowerCase())),
    items,
  };
}

/** The approved version everything is localized from: the job's source locale. */
export function sourceVersionOf(job: Job, site: Site): ArticleVersion | null {
  const versions = jobVersions(job);
  const source = jobGenerationLocales(job, site)[0];
  return versions.find((version) => version.locale === source) || versions[0] || null;
}

const LINK_RE = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;

function hrefOf(target: string): string {
  return target.trim().split(/\s+/, 1)[0];
}

/** Every link and image target in document order. */
export function linkTargets(content: string): string[] {
  return [...content.matchAll(LINK_RE)].map((match) => hrefOf(match[3]));
}

type PublishedArticle = { job_id: string; locale: string; slug: string };

export type SourceLinkFacts = {
  blogOrigin: string;
  hubUrls: Record<string, string>;
  published: PublishedArticle[];
  /** Job ids an `article:` reference may name (published articles and unpublished siblings). */
  referableJobIds: string[];
};

function blogArticlePath(href: string, blogOrigin: string): string | null {
  let path = href;
  if (/^https?:\/\//i.test(href)) {
    const origin = blogOrigin.trim().replace(/\/+$/, '').toLowerCase();
    if (!origin || !href.toLowerCase().startsWith(origin)) return null;
    path = href.slice(origin.length);
  }
  if (!path.startsWith('/')) return null;
  const match = /^\/([^/]+)\/blog\/([^/?#]+)\/?(?:[?#].*)?$/.exec(path);
  return match ? `${decodeURIComponent(match[1]).toLowerCase()}/${decodeURIComponent(match[2]).toLowerCase()}` : null;
}

/**
 * Normalizes the source body before the model sees it, so that keeping every
 * target unchanged is also correct in the target language:
 * - a blog URL written out literally becomes `article:<job_id>` when it names a
 *   published article, otherwise the link is dropped and its text kept;
 * - an `article:` reference to an article that no longer exists is dropped the
 *   same way (it already renders as plain text);
 * - an absolute hub URL of the source locale becomes the target locale's hub URL.
 */
export function prepareSourceContent(content: string, sourceLocale: string, targetLocale: string, facts: SourceLinkFacts): string {
  const sourceHub = facts.hubUrls[sourceLocale];
  const targetHub = facts.hubUrls[targetLocale];
  return content.replace(LINK_RE, (whole, bang: string, text: string, rawTarget: string) => {
    if (bang) return whole;
    const href = hrefOf(rawTarget);
    if (href.startsWith(ARTICLE_REF_PREFIX)) {
      return facts.referableJobIds.includes(href.slice(ARTICLE_REF_PREFIX.length).trim()) ? whole : text;
    }
    if (sourceHub && targetHub && href.replace(/\/+$/, '') === sourceHub.replace(/\/+$/, '')) {
      return `[${text}](${targetHub})`;
    }
    const path = blogArticlePath(href, facts.blogOrigin);
    if (!path) return whole;
    const [locale, slug] = path.split('/');
    const hit = facts.published.find((article) => article.locale.toLowerCase() === locale && article.slug.toLowerCase() === slug)
      || facts.published.find((article) => article.slug.toLowerCase() === slug);
    return hit ? `[${text}](${ARTICLE_REF_PREFIX}${hit.job_id})` : text;
  });
}

/** ASCII kebab-case in the target language; accents are folded rather than dropped. */
export function normalizeSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/g, '');
}

/** A slug no other article (current or former URL) in this locale owns. */
export function availableSlug(slug: string, locale: string, jobs: Job[], selfJobId: string): string {
  const taken = (candidate: string) => jobs.some((job) => job.id !== selfJobId && ownsArticleUrl(job, locale, candidate));
  if (!taken(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

export type LocalizationPromptInput = {
  source: ArticleVersion;
  preparedContent: string;
  targetLocale: string;
  businessContext: string;
};

export function localizationMessages(input: LocalizationPromptInput): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const system = [
    'You localize an approved, published blog article for readers in another language market.',
    'Write the article as a native editor in that market would: natural phrasing, the terms readers there actually search for and use, locally meaningful examples and units where the source uses illustrative ones. This is localization, not word-for-word translation.',
    'Keep the article\'s meaning, structure, claims, evidence and scope. Do not add facts, statistics, customers, outcomes, sources or product capabilities that are not in the source or in the confirmed business facts. Do not remove caveats or limitations.',
    'Use the complete official product name exactly as in the confirmed business facts every time you name a product. Never shorten it, invent an abbreviation or translate it unless the business facts give an approved localized full name.',
    'Links: keep every link and image target exactly as written, in the same order, including targets starting with "article:" (they resolve to the reader\'s language automatically). Translate only the link text and image alt text. Never add, remove or change a target.',
    ARTICLE_MARKDOWN_CAPABILITIES,
    'Reply with exactly these tagged sections and nothing else:',
    '<title>localized title</title>',
    '<slug>lowercase-ascii-kebab-case slug in the target language</slug>',
    '<excerpt>localized one or two sentence summary</excerpt>',
    '<meta_description>localized search description, about 150 characters</meta_description>',
    '<image_alt>localized cover image alt text, or empty</image_alt>',
    '<content>',
    'localized Markdown body without the H1',
    '</content>',
  ].join('\n');
  const user = [
    `Target locale (BCP-47): ${input.targetLocale}`,
    `Source locale: ${input.source.locale}`,
    '',
    '# Confirmed business facts',
    input.businessContext,
    '',
    '# Source article',
    `<title>${input.source.title}</title>`,
    `<excerpt>${input.source.excerpt}</excerpt>`,
    `<meta_description>${input.source.meta_description || ''}</meta_description>`,
    `<image_alt>${input.source.image_url ? input.source.image_alt || '' : ''}</image_alt>`,
    '<content>',
    input.preparedContent,
    '</content>',
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function section(text: string, name: string): string {
  const open = `<${name}>`;
  const close = `</${name}>`;
  const start = text.indexOf(open);
  if (start < 0) return '';
  const end = name === 'content' ? text.lastIndexOf(close) : text.indexOf(close, start);
  if (end < start) return '';
  return text.slice(start + open.length, end).trim();
}

export type LocalizedFields = { title: string; slug: string; excerpt: string; meta_description: string; image_alt: string; content: string };

export function parseLocalizedOutput(text: string): LocalizedFields {
  return {
    title: section(text, 'title'),
    slug: section(text, 'slug'),
    excerpt: section(text, 'excerpt'),
    meta_description: section(text, 'meta_description'),
    image_alt: section(text, 'image_alt'),
    content: section(text, 'content'),
  };
}

/** Problems the model must fix; empty means the version may go live. */
export function localizationIssues(fields: LocalizedFields, preparedContent: string, qa: QaReport): string[] {
  const issues: string[] = [];
  if (!fields.title) issues.push('The <title> section is missing or empty.');
  if (!fields.content) issues.push('The <content> section is missing or empty.');
  if (!normalizeSlug(fields.slug)) issues.push('The <slug> section is missing or has no usable characters.');
  const expected = linkTargets(preparedContent);
  const received = linkTargets(fields.content);
  if (fields.content && expected.join('\n') !== received.join('\n')) {
    const missing = expected.filter((target) => !received.includes(target));
    const extra = received.filter((target) => !expected.includes(target));
    issues.push(
      `Link and image targets must match the source exactly and in the same order. Source targets: ${JSON.stringify(expected)}.` +
      (missing.length ? ` Missing: ${JSON.stringify(missing)}.` : '') +
      (extra.length ? ` Not in source: ${JSON.stringify(extra)}.` : '') +
      (!missing.length && !extra.length ? ' The order or count differs.' : ''),
    );
  }
  if (fields.content) issues.push(...qa.issues.map((issue) => issue.message));
  return issues;
}

export function localizedVersion(fields: LocalizedFields, source: ArticleVersion, locale: string, slug: string): ArticleVersion {
  return {
    locale,
    slug,
    title: fields.title,
    excerpt: fields.excerpt,
    content: fields.content,
    ...(fields.meta_description ? { meta_description: fields.meta_description } : {}),
    ...(source.image_url ? { image_url: source.image_url, image_alt: fields.image_alt || source.image_alt || '' } : {}),
  };
}

/** A failure that another identical attempt would not fix. */
export class LocalizationRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalizationRejected';
  }
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function requestLocalization(profile: ResolvedModelProfile, messages: ChatMessage[]): Promise<string> {
  const result = await requestModelText(profile, { messages, maxTokens: 32_000, reasoningEffort: 'low', timeoutMs: 300_000 });
  if (result.finishReason === 'length') throw new Error('Model output was cut off before the article finished');
  const content = result.content.trim();
  if (!content) throw new Error('Model response missing content');
  return content;
}

/**
 * Appends the version only if the job is still published and still lacks the
 * locale. Guarded on the versions it read, so two locales finishing at the same
 * time cannot overwrite each other.
 */
export async function attachLocalizedVersion(db: D1Database, jobId: string, version: ArticleVersion): Promise<'attached' | 'exists' | 'not_published'> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const job = await db.prepare('select * from jobs where id = ?').bind(jobId).first<Job>();
    if (!job || job.status !== 'published') return 'not_published';
    const versions = jobVersions(job);
    if (versions.some((existing) => existing.locale.toLowerCase() === version.locale.toLowerCase())) return 'exists';
    const next = [...versions, version];
    const patch = versionsPatch(next);
    const locales = jobGenerationLocales(job);
    const translate = [...new Set([...locales.slice(1), version.locale])].filter((locale) => locale !== locales[0]);
    const result = await db.prepare(
      `update jobs set versions_json = ?, translate_locales_json = ?,
         en_slug = ?, en_title = ?, en_excerpt = ?, en_content = ?,
         pt_slug = ?, pt_title = ?, pt_excerpt = ?, pt_content = ?,
         url_aliases_json = ?, updated_at = ?
       where id = ? and status = 'published' and versions_json is ?`,
    ).bind(
      patch.versions_json, JSON.stringify(translate),
      patch.en_slug ?? null, patch.en_title ?? null, patch.en_excerpt ?? null, patch.en_content ?? null,
      patch.pt_slug ?? null, patch.pt_title ?? null, patch.pt_excerpt ?? null, patch.pt_content ?? null,
      nextArticleAliases(job), new Date().toISOString(),
      jobId, job.versions_json ?? null,
    ).run();
    if (result.meta.changes) return 'attached';
  }
  throw new Error('The article kept changing while its localized version was being saved');
}

/**
 * Takes a localized locale off the live article. The source version stays; the
 * removed URL is kept as a reserved former URL.
 */
export async function removeLocalizedVersion(db: D1Database, job: Job, site: Site, locale: string): Promise<'removed' | 'source' | 'absent'> {
  const source = sourceVersionOf(job, site);
  if (source && source.locale.toLowerCase() === locale.toLowerCase()) return 'source';
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await db.prepare('select * from jobs where id = ?').bind(job.id).first<Job>();
    if (!current) return 'absent';
    const versions = jobVersions(current);
    const next = versions.filter((version) => version.locale.toLowerCase() !== locale.toLowerCase());
    if (next.length === versions.length || !next.length) return 'absent';
    const patch = versionsPatch(next);
    const translate = jobGenerationLocales(current).slice(1).filter((code) => code.toLowerCase() !== locale.toLowerCase());
    const result = await db.prepare(
      `update jobs set versions_json = ?, translate_locales_json = ?,
         en_slug = ?, en_title = ?, en_excerpt = ?, en_content = ?,
         pt_slug = ?, pt_title = ?, pt_excerpt = ?, pt_content = ?,
         url_aliases_json = ?, updated_at = ?
       where id = ? and versions_json is ?`,
    ).bind(
      patch.versions_json, JSON.stringify(translate),
      patch.en_slug ?? null, patch.en_title ?? null, patch.en_excerpt ?? null, patch.en_content ?? null,
      patch.pt_slug ?? null, patch.pt_title ?? null, patch.pt_excerpt ?? null, patch.pt_content ?? null,
      nextArticleAliases(current), new Date().toISOString(),
      job.id, current.versions_json ?? null,
    ).run();
    if (result.meta.changes) {
      await db.prepare('delete from article_localizations where job_id = ? and lower(locale) = lower(?)').bind(job.id, locale).run();
      return 'removed';
    }
  }
  throw new Error('The article kept changing while the language version was being removed');
}

export async function setLocalizationStatus(db: D1Database, id: string, status: LocalizationStatus, error = ''): Promise<void> {
  await db.prepare('update article_localizations set status = ?, error = ?, updated_at = ? where id = ?')
    .bind(status, error.slice(0, 1000), new Date().toISOString(), id).run();
}

export async function listLocalizations(db: D1Database, siteId: string): Promise<LocalizationRow[]> {
  const { results } = await db.prepare('select * from article_localizations where site_id = ? order by created_at asc')
    .bind(siteId).all<LocalizationRow>();
  return results ?? [];
}

/**
 * Claims a locale for a new run. Returns false when a run for it is already in
 * progress (and not stale), so a double click starts nothing twice.
 */
export async function claimLocalization(db: D1Database, row: Pick<LocalizationRow, 'id' | 'site_id' | 'job_id' | 'locale'>, now = new Date()): Promise<string | null> {
  const at = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_MS).toISOString();
  await db.prepare(
    `insert into article_localizations (id, site_id, job_id, locale, status, workflow_id, error, created_at, updated_at)
     values (?, ?, ?, ?, 'running', '', '', ?, ?)
     on conflict(job_id, locale) do update set status = 'running', workflow_id = '', error = '', id = excluded.id, updated_at = excluded.updated_at
     where article_localizations.status <> 'running' or article_localizations.updated_at < ?`,
  ).bind(row.id, row.site_id, row.job_id, row.locale, at, at, staleBefore).run();
  const claimed = await db.prepare('select id from article_localizations where job_id = ? and locale = ?')
    .bind(row.job_id, row.locale).first<{ id: string }>();
  return claimed?.id === row.id ? row.id : null;
}
