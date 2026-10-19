import type { IngestPayload, Job } from '../types';
import { jobVersions } from './versions';

export type IngestValidation = { ok: true; payload: IngestPayload } | { ok: false; error: string };

export function validateIngestPayload(body: unknown): IngestValidation {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const raw = body as Record<string, unknown>;
  const translation_group = str(raw.translation_group);
  const category = str(raw.category);
  if (!translation_group) return { ok: false, error: 'translation_group is required' };
  if (!category) return { ok: false, error: 'category is required' };

  const versions = raw.versions;
  if (!Array.isArray(versions) || versions.length < 2) {
    return { ok: false, error: 'versions must include at least two locales' };
  }

  const parsed = [];
  for (const v of versions) {
    if (!v || typeof v !== 'object') return { ok: false, error: 'each version must be an object' };
    const row = v as Record<string, unknown>;
    const locale = str(row.locale);
    const slug = str(row.slug);
    const title = str(row.title);
    const content = str(row.content);
    if (!locale || !slug || !title || !content) {
      return { ok: false, error: 'each version needs locale, slug, title, content' };
    }
    parsed.push({
      locale,
      slug,
      title,
      excerpt: str(row.excerpt),
      content,
    });
  }

  const locales = new Set(parsed.map((v) => v.locale));
  if (!locales.has('en') || !locales.has('pt-BR')) {
    return { ok: false, error: 'versions must include locale en and pt-BR' };
  }

  const payload: IngestPayload = {
    translation_group,
    category,
    status: 'published',
    versions: parsed,
  };
  if (raw.dry_run === true) payload.dry_run = true;
  return { ok: true, payload };
}

export function jobToIngestPayload(job: {
  translation_group: string | null;
  category: string | null;
  versions_json?: string;
  en_slug: string | null;
  en_title: string | null;
  en_excerpt: string | null;
  en_content: string | null;
  pt_slug: string | null;
  pt_title: string | null;
  pt_excerpt: string | null;
  pt_content: string | null;
}): IngestPayload {
  const versions = jobVersions(job as Job);
  return {
    translation_group: job.translation_group || versions[0]?.slug || '',
    category: job.category || 'METHOD',
    status: 'published',
    versions,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
