import { describe, expect, it } from 'vitest';
import {
  mergeNameByLocalePatch,
  nameByLocaleOf,
  organizationNameForLocale,
  siteNameForLocale,
} from './site-name';

const site = (nameByLocaleJson: string, seoIdentityJson = '{}') => ({
  name: 'Acme English',
  name_by_locale_json: nameByLocaleJson,
  seo_identity_json: seoIdentityJson,
});

describe('nameByLocaleOf', () => {
  it('parses stored entries and tolerates malformed json', () => {
    expect(nameByLocaleOf({ name_by_locale_json: '{"pt-BR":{"value":"Acme Inglês","deleted_at":null}}' })).toEqual({
      'pt-BR': { value: 'Acme Inglês', deleted_at: null },
    });
    expect(nameByLocaleOf({ name_by_locale_json: 'not-json' })).toEqual({});
    expect(nameByLocaleOf({ name_by_locale_json: null })).toEqual({});
  });
});

describe('siteNameForLocale', () => {
  it('uses the live localized name for the page locale', () => {
    expect(siteNameForLocale(site('{"pt-BR":{"value":"Acme Inglês","deleted_at":null}}'), 'pt-BR')).toBe('Acme Inglês');
  });

  it('ignores tombstoned entries and unknown locales', () => {
    const s = site('{"pt-BR":{"value":"Acme Inglês","deleted_at":"2026-01-01T00:00:00Z"}}');
    expect(siteNameForLocale(s, 'pt-BR')).toBe('Acme English');
    expect(siteNameForLocale(s, 'fr')).toBe('Acme English');
    expect(siteNameForLocale(s, null)).toBe('Acme English');
  });
});

describe('organizationNameForLocale', () => {
  it('prefers an explicitly configured organization name', () => {
    const s = site('{"pt-BR":{"value":"Acme Inglês","deleted_at":null}}', '{"organizationName":"Acme Ltd"}');
    expect(organizationNameForLocale(s, 'pt-BR')).toBe('Acme Ltd');
  });

  it('falls back to the localized site name', () => {
    expect(organizationNameForLocale(site('{"pt-BR":{"value":"Acme Inglês","deleted_at":null}}'), 'pt-BR')).toBe('Acme Inglês');
  });
});

describe('mergeNameByLocalePatch', () => {
  it('sets values and clears tombstones', () => {
    const merged = mergeNameByLocalePatch('{"pt-BR":{"value":"Old","deleted_at":"2026-01-01T00:00:00Z"}}', {
      'pt-BR': 'Acme Inglês',
    });
    expect(JSON.parse(merged)).toEqual({ 'pt-BR': { value: 'Acme Inglês', deleted_at: null } });
  });

  it('soft deletes by keeping the value and stamping deleted_at', () => {
    const merged = mergeNameByLocalePatch('{"pt-BR":{"value":"Acme Inglês","deleted_at":null}}', {
      'pt-BR': { deleted: true },
    });
    const entry = JSON.parse(merged)['pt-BR'];
    expect(entry.value).toBe('Acme Inglês');
    expect(entry.deleted_at).toBeTruthy();
  });

  it('never drops unrelated locales', () => {
    const merged = mergeNameByLocalePatch(
      '{"pt-BR":{"value":"Acme Inglês","deleted_at":null},"fr":{"value":"Acme FR","deleted_at":null}}',
      { ja: 'アクメ' },
    );
    const parsed = JSON.parse(merged);
    expect(parsed['fr'].value).toBe('Acme FR');
    expect(parsed['pt-BR'].value).toBe('Acme Inglês');
    expect(parsed['ja'].value).toBe('アクメ');
  });
});
