import type { Job } from '../types';
import { jobVersions } from '../lib/versions';

export type ArticleAlias = { locale: string; slug: string };

export function articleAliases(job: Pick<Job, 'url_aliases_json'>): ArticleAlias[] {
  try {
    const rows: unknown = JSON.parse(job.url_aliases_json || '[]');
    return Array.isArray(rows) ? rows.filter((row): row is ArticleAlias => !!row && typeof row.locale === 'string' && typeof row.slug === 'string') : [];
  } catch { return []; }
}

export function nextArticleAliases(current: Job): string {
  const aliases = articleAliases(current);
  if (current.published_at || current.status === 'published') {
    for (const version of jobVersions(current)) {
      if (version.slug && !aliases.some((a) => a.locale === version.locale && a.slug === version.slug)) {
        aliases.push({ locale: version.locale, slug: version.slug });
      }
    }
  }
  // Keep former current URLs too: they are reserved even during a revision or unpublish.
  return JSON.stringify(aliases);
}

export function ownsArticleUrl(job: Job, locale: string, slug: string): boolean {
  return [...jobVersions(job), ...articleAliases(job)].some((v) => v.locale === locale && v.slug === slug);
}
