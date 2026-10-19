import { describe, expect, it } from 'vitest';
import type { Job, Site } from '../types';
import { EMPTY_SITE_GSC, EMPTY_SITE_RESEARCH } from '../types';
import {
  localePreferenceCookieName,
  localePreferenceRedirect,
  localizedHomeRedirect,
  savedLocalePreference,
  serveBlog,
} from './live';
import { publishedLocalePolicy } from './render';
import { mergeLocalePolicy } from './seo';

function site(partial: Partial<Site> = {}): Site {
  return {
    id: 'site-1',
    workspace_id: 'primary-workspace',
    name: 'Acme',
    domain: 'blog.example.com',
    root_domain: 'example.com',
    ingest_url: '',
    ingest_secret: '',
    secret_header: 'x-ingest-secret',
    locales_json: '["en"]',
    translate_locales_json: '[]',
    webhook_fields_json: '[]',
    webhook_mode: 'group',
    hub_path: '/start',
    product_origin: 'https://www.example.com',
    locale_policy_json: '',
    source_locale: 'en',
    hub_urls_json: '{}',
    seo_identity_json: '{}',
    blog_layout: 'magazine',
    model: 'x',
    min_words: 400,
    created_at: '2026-01-01',
    domain_status: 'live',
    domain_error: '',
    domain_checked_at: '',
    ...EMPTY_SITE_GSC,
    ...EMPTY_SITE_RESEARCH,
    ...partial,
  };
}

function job(partial: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    site_id: 'site-1',
    topic_id: null,
    status: 'published',
    visibility: 'visible',
    translation_group: 'hello',
    category: '',
    translate_locales_json: '[]',
    versions_json: JSON.stringify([
      { locale: 'en', slug: 'hello', title: 'Hello', excerpt: 'Ex', content: 'Body.' },
    ]),
    en_slug: 'hello',
    en_title: 'Hello',
    en_excerpt: 'Ex',
    en_content: 'Body.',
    pt_slug: null,
    pt_title: null,
    pt_excerpt: null,
    pt_content: null,
    qa_report: null,
    review_note: null,
    workflow_id: null,
    error: null,
    publish_response: null,
    published_at: '2026-08-18T00:00:00.000Z',
    content_updated_at: '2026-08-18T00:00:00.000Z',
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    ...partial,
  };
}

const fakeEnv = {} as unknown as Env;

async function serve(jobs: Job[], match: Parameters<typeof serveBlog>[3], opts: { hosted?: boolean; headers?: Record<string, string> } = {}) {
  const hosted = opts.hosted ?? true;
  const s = site();
  const policy = publishedLocalePolicy(s, jobs);
  const request = new Request('https://blog.example.com/', { headers: opts.headers });
  return serveBlog(request, fakeEnv, s, match, hosted, jobs, policy);
}

describe('localizedHomeRedirect', () => {
  const policy = mergeLocalePolicy(['en', 'pt-BR', 'zh-CN'], null, 'en');

  it('temporarily redirects the root to the best published browser-language match', () => {
    const response = localizedHomeRedirect(
      new Request('https://blog.example.com/', { headers: { 'Accept-Language': 'pt-PT, en;q=0.8' } }),
      'https://blog.example.com',
      policy,
      ['en', 'pt-BR'],
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://blog.example.com/pt/blog');
    expect(response.headers.get('vary')).toBe('Cookie, Accept-Language');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('never redirects to a configured locale that has no published content', () => {
    const response = localizedHomeRedirect(
      new Request('https://blog.example.com/', { headers: { 'Accept-Language': 'zh-CN' } }),
      'https://blog.example.com',
      policy,
      ['en', 'pt-BR'],
    );
    expect(response.headers.get('location')).toBe('https://blog.example.com/en/blog');
  });

  it('prefers a saved manual choice over the browser language', () => {
    const cookieName = localePreferenceCookieName('site-1');
    const response = localizedHomeRedirect(
      new Request('https://blog.example.com/', {
        headers: {
          'Accept-Language': 'pt-BR,pt;q=0.9',
          Cookie: `${cookieName}=en`,
        },
      }),
      'https://blog.example.com',
      policy,
      ['en', 'pt-BR'],
      cookieName,
    );
    expect(response.headers.get('location')).toBe('https://blog.example.com/en/blog');
  });

  it('falls back to English when neither preference nor browser language is supported', () => {
    const portugueseDefault = mergeLocalePolicy(['pt-BR', 'en'], null, 'pt-BR');
    const response = localizedHomeRedirect(
      new Request('https://blog.example.com/', { headers: { 'Accept-Language': 'ja-JP' } }),
      'https://blog.example.com',
      portugueseDefault,
      ['pt-BR', 'en'],
    );
    expect(response.headers.get('location')).toBe('https://blog.example.com/en/blog');
  });

  it('treats a published regional English locale as the English fallback', () => {
    const regionalPolicy = mergeLocalePolicy(['pt-BR', 'en-US'], null, 'pt-BR');
    const response = localizedHomeRedirect(
      new Request('https://blog.example.com/', { headers: { 'Accept-Language': 'ja-JP' } }),
      'https://blog.example.com',
      regionalPolicy,
      ['pt-BR', 'en-US'],
    );
    expect(response.headers.get('location')).toBe('https://blog.example.com/en/blog');
  });
});

describe('locale preference persistence', () => {
  it('sets a site-scoped cookie only for a valid matching locale and redirects to the clean URL', () => {
    const response = localePreferenceRedirect(
      new Request('https://blog.example.com/pt/blog?set_locale=pt-BR&utm_source=menu'),
      'site-1',
      'pt-BR',
      ['en', 'pt-BR'],
    );
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('https://blog.example.com/pt/blog?utm_source=menu');
    expect(response?.headers.get('set-cookie')).toContain(`${localePreferenceCookieName('site-1')}=pt-BR`);
    expect(response?.headers.get('set-cookie')).toContain('Max-Age=31536000');
    expect(response?.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('ignores stale and malformed preferences', () => {
    expect(savedLocalePreference('blog_locale=fr', 'blog_locale', ['en', 'pt-BR'])).toBeNull();
    expect(savedLocalePreference('blog_locale=%E0%A4%A', 'blog_locale', ['en', 'pt-BR'])).toBeNull();
  });
});

describe('serveBlog: pagination bounds', () => {
  it('renders page 1 of an empty locale instead of 404ing it', async () => {
    const res = await serve([], { kind: 'list', locale: 'en', page: 1 });
    expect(res.status).toBe(200);
  });

  it('404s a page number past the real last page instead of silently repeating it', async () => {
    const res = await serve([], { kind: 'list', locale: 'en', page: 2 });
    expect(res.status).toBe(404);
  });

  it('accepts the real last page and rejects the one after it', async () => {
    const manyJobs = Array.from({ length: 51 }, (_, i) =>
      job({
        id: `j-${i}`,
        translation_group: `g-${i}`,
        versions_json: JSON.stringify([{ locale: 'en', slug: `post-${i}`, title: `Post ${i}`, excerpt: 'Ex', content: 'Body.' }]),
      }),
    );
    const page2 = await serve(manyJobs, { kind: 'list', locale: 'en', page: 2 });
    expect(page2.status).toBe(200);
    const page3 = await serve(manyJobs, { kind: 'list', locale: 'en', page: 3 });
    expect(page3.status).toBe(404);
  });
});

describe('serveBlog: conditional GET on articles', () => {
  const match = { kind: 'article' as const, locale: 'en', slug: 'hello' };

  it('sends a representation ETag instead of an incomplete article-only modification date', async () => {
    const res = await serve([job()], match);
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.headers.get('Last-Modified')).toBeNull();
  });

  it('returns 304 only for a matching complete representation', async () => {
    const first = await serve([job()], match);
    const res = await serve([job()], match, { headers: { 'If-None-Match': first.headers.get('ETag')! } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    const dateOnly = await serve([job()], match, { headers: { 'If-Modified-Since': '2099-01-01T00:00:00Z' } });
    expect(dateOnly.status).toBe(200);
  });

  it('still renders when If-Modified-Since predates the last real change', async () => {
    const res = await serve([job()], match, { headers: { 'If-Modified-Since': '2026-08-01T00:00:00.000Z' } });
    expect(res.status).toBe(200);
  });

  it('ignores a malformed If-Modified-Since rather than treating it as a match', async () => {
    const res = await serve([job()], match, { headers: { 'If-Modified-Since': 'not-a-date' } });
    expect(res.status).toBe(200);
  });
});
