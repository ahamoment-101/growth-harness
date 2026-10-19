import type { ArticleVersion, Job, Site, WebhookField } from '../types';
import { sourceLocaleOf } from '../blog/seo';
import { jobVersions } from './versions';

/** @deprecated Use `sourceLocaleOf(site)` — source language is per tenant. */
export const SOURCE_LOCALE = 'en';

/** Prefab object posted when a custom field uses `from: 'languages'`. */
export type LanguagesBundle = {
  content_id: string;
  languages: Array<{
    code: string;
    slug: string;
    title: string;
    excerpt: string;
    content: string;
  }>;
};

export function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

export function translateLocalesOf(site: Site): string[] {
  const source = sourceLocaleOf(site);
  const explicit = parseJsonArray<string>(site.translate_locales_json, []);
  return unique(explicit.map((x) => x.trim()).filter((x) => x && x !== source));
}

export function generationLocales(site: Site): string[] {
  return unique([sourceLocaleOf(site), ...translateLocalesOf(site)]);
}

/** Locales for this job. Source locale is first. Empty job list = source only (not workspace leftovers). */
export function jobGenerationLocales(job: Pick<Job, 'translate_locales_json' | 'versions_json'> & Partial<Pick<Job, 'source_locale'>>, site?: Site | null): string[] {
  const source = job.source_locale || (site ? sourceLocaleOf(site) : SOURCE_LOCALE);
  if (job.translate_locales_json != null && job.translate_locales_json !== '') {
    const extra = parseJsonArray<string>(job.translate_locales_json, []);
    return unique([source, ...extra.map((x) => x.trim()).filter((x) => x && x !== source)]);
  }
  if (site) return generationLocales(site);
  const fromVersions = jobVersions(job as Job)
    .map((v) => v.locale)
    .filter(Boolean);
  return unique(fromVersions.length ? fromVersions : [source]);
}

export function webhookFieldsOf(site: Pick<Site, 'webhook_fields_json'>): WebhookField[] {
  const fields = parseJsonArray<WebhookField>(site.webhook_fields_json, []);
  return fields.filter((f) => f && typeof f.key === 'string' && typeof f.from === 'string');
}

/** Optional export: only when the site has an ingest URL and at least one mapped field. */
export function webhookExportEnabled(site: Pick<Site, 'ingest_url' | 'webhook_fields_json'>): boolean {
  return Boolean(site.ingest_url.trim()) && webhookFieldsOf(site).length > 0;
}

export function languagesBundle(job: Job, versions: ArticleVersion[]): LanguagesBundle {
  const list = versions.length ? versions : [];
  return {
    content_id: job.translation_group || list[0]?.slug || job.id,
    languages: list.map((v) => ({
      code: v.locale,
      slug: v.slug,
      title: v.title,
      excerpt: v.excerpt,
      content: v.content,
    })),
  };
}

export function buildWebhookPosts(
  site: Site,
  job: Job,
  opts: { dryRun?: boolean } = {},
): Record<string, unknown>[] {
  const versions = jobVersions(job);
  const fields = webhookFieldsOf(site);
  if (!fields.length) {
    throw new Error('Add at least one custom field on the workspace before publishing');
  }
  const list = versions.length ? versions : dummyVersions(site, job);
  return [mapFields(fields, { job, versions: list, dryRun: Boolean(opts.dryRun) })];
}

function dummyVersions(site: Site, job: Job): ArticleVersion[] {
  const locales = jobGenerationLocales(job, site);
  return locales.map((locale, i) => ({
    locale,
    slug: i === 0 ? 'connectivity-test' : `connectivity-test-${locale.toLowerCase()}`,
    title: 'Connectivity test',
    excerpt: 'Dry run',
    content: `Dry run. Practice [write from memory](${site.hub_path}).`,
  }));
}

function mapFields(
  fields: WebhookField[],
  ctx: {
    job: Job;
    versions: ArticleVersion[];
    dryRun: boolean;
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    body[field.key] = resolveSource(field, ctx);
  }
  if (ctx.dryRun && body.dry_run == null) body.dry_run = true;
  return body;
}

function sourceVersion(ctx: { versions: ArticleVersion[] }): ArticleVersion | undefined {
  return ctx.versions[0];
}

function resolveSource(
  field: WebhookField,
  ctx: {
    job: Job;
    versions: ArticleVersion[];
    dryRun: boolean;
  },
): unknown {
  const version = sourceVersion(ctx);
  switch (field.from) {
    case 'languages':
      return languagesBundle(ctx.job, ctx.versions);
    case 'versions':
      return ctx.versions;
    case 'locale':
    case 'language':
      return version?.locale ?? '';
    case 'slug':
      return version?.slug ?? '';
    case 'title':
      return version?.title ?? '';
    case 'excerpt':
      return version?.excerpt ?? '';
    case 'content':
      return version?.content ?? '';
    case 'content_id':
    case 'translation_group':
      return ctx.job.translation_group || version?.slug || '';
    case 'category':
      return ctx.job.category || '';
    case 'status':
      return 'published';
    case 'dry_run':
      return ctx.dryRun;
    case 'literal':
      return field.value ?? '';
    default:
      return field.value ?? '';
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
