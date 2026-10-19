import type { Site } from '../types';
import { parseSeoIdentity } from './seo';

export type SiteNameEntry = { value: string; deleted_at: string | null };
export type SiteNameByLocale = Record<string, SiteNameEntry>;

/** Update payload accepted from the console: a string sets/restores the value, `{ deleted: true }` tombstones it. */
export type SiteNamePatch = Record<string, string | { deleted: boolean }>;

export function nameByLocaleOf(site: Pick<Site, 'name_by_locale_json'>): SiteNameByLocale {
  try {
    const parsed = JSON.parse(site.name_by_locale_json || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SiteNameByLocale = {};
    for (const [code, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Partial<SiteNameEntry>;
      if (typeof record.value !== 'string') continue;
      out[code.trim()] = {
        value: record.value,
        deleted_at: typeof record.deleted_at === 'string' ? record.deleted_at : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Live (non-tombstoned) localized name for a page locale; falls back to the base site name. */
export function siteNameForLocale(
  site: Pick<Site, 'name' | 'name_by_locale_json'>,
  locale?: string | null,
): string {
  if (locale) {
    const entry = nameByLocaleOf(site)[locale];
    const value = entry?.value.trim();
    if (entry && !entry.deleted_at && value) return value;
  }
  return site.name;
}

/**
 * Publisher name for structured data: an explicitly configured organizationName wins, else the
 * localized site name. Deliberately not used for visible page copy — organizationName is one global
 * string, so it would print the same language on every locale (see the footer in `render.ts`).
 */
export function organizationNameForLocale(
  site: Pick<Site, 'name' | 'name_by_locale_json' | 'seo_identity_json'>,
  locale?: string | null,
): string {
  const configured = parseSeoIdentity(site.seo_identity_json).organizationName?.trim();
  if (configured) return configured;
  return siteNameForLocale(site, locale);
}

/**
 * Merge a console patch into the stored map. Never drops entries: strings
 * set the value and clear the tombstone, `{ deleted: true }` keeps the value
 * and stamps `deleted_at` so the locale can be restored later.
 */
export function mergeNameByLocalePatch(previousJson: string | null | undefined, patch: SiteNamePatch): string {
  const merged = nameByLocaleOf({ name_by_locale_json: previousJson || '{}' });
  for (const [code, incoming] of Object.entries(patch)) {
    const locale = code.trim();
    if (!locale) continue;
    const previous = merged[locale];
    if (typeof incoming === 'string') {
      merged[locale] = { value: incoming, deleted_at: null };
    } else if (incoming.deleted) {
      merged[locale] = { value: previous?.value ?? '', deleted_at: new Date().toISOString() };
    } else if (previous) {
      merged[locale] = { ...previous, deleted_at: null };
    }
  }
  return JSON.stringify(merged);
}
