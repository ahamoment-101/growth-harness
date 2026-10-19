import { describe, expect, it } from 'vitest';
import type { Job, Site } from '../types';
import { EMPTY_SITE_GSC, EMPTY_SITE_RESEARCH } from '../types';
import { buildWebhookPosts, jobGenerationLocales, webhookExportEnabled } from './webhook';

function site(partial: Partial<Site> = {}): Site {
  return {
    id: 's1',
    workspace_id: 'primary-workspace',
    name: 'Test',
    domain: '',
    root_domain: '',
    ingest_url: 'https://example.com/hooks/publish',
    ingest_secret: '',
    secret_header: 'x-ingest-secret',
    locales_json: '["en"]',
    translate_locales_json: '[]',
    webhook_fields_json: '[]',
    webhook_mode: 'group',
    hub_path: '/write-english',
    product_origin: '',
    locale_policy_json: '',
    source_locale: 'en',
    hub_urls_json: '{}',
    seo_identity_json: '{}',
    blog_layout: 'magazine',
    model: 'x',
    min_words: 400,
    created_at: '2026-01-01',
    domain_status: 'unverified',
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
    site_id: 's1',
    topic_id: null,
    status: 'queued',
    visibility: 'visible',
    translation_group: 'hello',
    category: 'METHOD',
    translate_locales_json: '[]',
    versions_json: JSON.stringify([
      { locale: 'en', slug: 'hello', title: 'Hello', excerpt: 'e', content: 'c' },
      { locale: 'pt-BR', slug: 'ola', title: 'Olá', excerpt: 'e2', content: 'c2' },
    ]),
    en_slug: null,
    en_title: null,
    en_excerpt: null,
    en_content: null,
    pt_slug: null,
    pt_title: null,
    pt_excerpt: null,
    pt_content: null,
    qa_report: null,
    review_note: null,
    workflow_id: null,
    error: null,
    publish_response: null,
    published_at: null,
    content_updated_at: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...partial,
  };
}

describe('webhookExportEnabled', () => {
  it('is off when ingest_url is empty', () => {
    expect(
      webhookExportEnabled(
        site({
          ingest_url: '',
          webhook_fields_json: JSON.stringify([{ key: 'article', from: 'languages' }]),
        }),
      ),
    ).toBe(false);
  });

  it('is on when URL and at least one field exist', () => {
    expect(
      webhookExportEnabled(
        site({
          webhook_fields_json: JSON.stringify([{ key: 'article', from: 'languages' }]),
        }),
      ),
    ).toBe(true);
  });
});

describe('jobGenerationLocales', () => {
  it('is English-only when the job stored an empty list', () => {
    expect(jobGenerationLocales(job({ translate_locales_json: '[]' }), site({ translate_locales_json: '["pt-BR"]' }))).toEqual([
      'en',
    ]);
  });

  it('uses the job list, not leftover workspace locales', () => {
    expect(
      jobGenerationLocales(job({ translate_locales_json: '["pt-BR"]' }), site({ translate_locales_json: '["es"]' })),
    ).toEqual(['en', 'pt-BR']);
  });

  it('puts the site source locale first instead of assuming English', () => {
    expect(
      jobGenerationLocales(job({ translate_locales_json: '["en"]' }), site({ source_locale: 'ja', translate_locales_json: '["en"]' })),
    ).toEqual(['ja', 'en']);
  });
});

describe('buildWebhookPosts', () => {
  it('throws when no fields are configured', () => {
    expect(() => buildWebhookPosts(site(), job())).toThrow(
      'Add at least one custom field on the workspace before publishing',
    );
  });

  it('posts the languages prefab under the customer key', () => {
    const posts = buildWebhookPosts(
      site({
        webhook_fields_json: JSON.stringify([{ key: 'article', from: 'languages' }]),
      }),
      job(),
    );
    expect(posts).toEqual([
      {
        article: {
          content_id: 'hello',
          languages: [
            { code: 'en', slug: 'hello', title: 'Hello', excerpt: 'e', content: 'c' },
            { code: 'pt-BR', slug: 'ola', title: 'Olá', excerpt: 'e2', content: 'c2' },
          ],
        },
      },
    ]);
  });

  it('sends English primitives under customer keys', () => {
    const posts = buildWebhookPosts(
      site({
        webhook_fields_json: JSON.stringify([
          { key: 'headline', from: 'title' },
          { key: 'lang', from: 'locale' },
        ]),
      }),
      job(),
    );
    expect(posts).toEqual([{ headline: 'Hello', lang: 'en' }]);
  });
});
