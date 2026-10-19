import type { ArticleVersion, Job } from '../types';

export function parseLocales(localesJson: string): string[] {
  try {
    const parsed = JSON.parse(localesJson) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string' && x.trim())) {
      return parsed.map((x) => String(x).trim());
    }
  } catch {
    /* fall through */
  }
  return ['en'];
}

export function jobVersions(job: Job): ArticleVersion[] {
  if (job.versions_json) {
    try {
      const parsed = JSON.parse(job.versions_json) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(asVersion).filter((v): v is ArticleVersion => Boolean(v));
      }
    } catch {
      /* fall through to legacy columns */
    }
  }
  return legacyVersions(job);
}

export function orderVersions(versions: ArticleVersion[], locales: string[]): ArticleVersion[] {
  const byLocale = new Map(versions.map((v) => [v.locale, v]));
  const ordered: ArticleVersion[] = [];
  for (const locale of locales) {
    const hit = byLocale.get(locale);
    if (hit) {
      ordered.push(hit);
      byLocale.delete(locale);
    }
  }
  for (const rest of byLocale.values()) ordered.push(rest);
  return ordered;
}

export function upsertVersion(job: Job, version: ArticleVersion): ArticleVersion[] {
  const next = jobVersions(job).filter((v) => v.locale !== version.locale);
  next.push(version);
  return next;
}

export function versionsPatch(versions: ArticleVersion[]): Partial<Job> {
  const en = versions.find((v) => v.locale === 'en');
  const pt = versions.find((v) => v.locale === 'pt-BR' || v.locale === 'pt');
  const patch: Partial<Job> = {
    versions_json: JSON.stringify(versions),
    en_slug: en?.slug ?? null,
    en_title: en?.title ?? null,
    en_excerpt: en?.excerpt ?? null,
    en_content: en?.content ?? null,
    pt_slug: pt?.slug ?? null,
    pt_title: pt?.title ?? null,
    pt_excerpt: pt?.excerpt ?? null,
    pt_content: pt?.content ?? null,
  };
  const primary = versions[0];
  if (primary?.slug) patch.translation_group = primary.slug;
  patch.content_updated_at = new Date().toISOString();
  return patch;
}

function asVersion(raw: unknown): ArticleVersion | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const locale = typeof row.locale === 'string' ? row.locale.trim() : '';
  if (!locale) return null;
  return {
    locale,
    ...(typeof row.meta_description === 'string' ? { meta_description: row.meta_description } : {}),
    ...(typeof row.image_url === 'string' ? { image_url: row.image_url } : {}),
    ...(typeof row.image_alt === 'string' ? { image_alt: row.image_alt } : {}),
    slug: typeof row.slug === 'string' ? row.slug : '',
    title: typeof row.title === 'string' ? row.title : '',
    excerpt: typeof row.excerpt === 'string' ? row.excerpt : '',
    content: typeof row.content === 'string' ? row.content : '',
  };
}

function legacyVersions(job: Job): ArticleVersion[] {
  const versions: ArticleVersion[] = [];
  if (job.en_slug || job.en_title || job.en_content) {
    versions.push({
      locale: 'en',
      slug: job.en_slug || '',
      title: job.en_title || '',
      excerpt: job.en_excerpt || '',
      content: job.en_content || '',
    });
  }
  if (job.pt_slug || job.pt_title || job.pt_content) {
    versions.push({
      locale: 'pt-BR',
      slug: job.pt_slug || '',
      title: job.pt_title || '',
      excerpt: job.pt_excerpt || '',
      content: job.pt_content || '',
    });
  }
  return versions;
}
