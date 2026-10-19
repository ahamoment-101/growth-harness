import { describe, expect, it } from 'vitest';
import { normalizeDomain, parseResearchConfigBody, researchConfigOf } from './config';
import { keywordHintFromUrl, parseSitemapXml } from './fetch';
import { EMPTY_SITE_GSC, EMPTY_SITE_RESEARCH, type Site } from '../../types';

function site(partial: Partial<Site> = {}): Site {
  return {
    id: 's1',
    workspace_id: 'primary-workspace',
    name: 'Example Product',
    domain: 'blog.example.com',
    root_domain: 'example.com',
    ingest_url: '',
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

describe('research config', () => {
  it('parses competitor domains from newline text and strips urls', () => {
    const cfg = parseResearchConfigBody(
      { competitor_domains: 'https://Competitor.example/blog\ncompetitor.example\n\nalternative.example' },
      researchConfigOf(site()),
    );
    expect(cfg.competitor_domains).toEqual(['competitor.example', 'alternative.example']);
  });

  it('ignores retired scheduling settings in persisted sites and incoming config', () => {
    const cfg = researchConfigOf(site({ research_enabled: 1, research_timezone: 'UTC', research_weekday: 1, research_hour: 9 }));
    expect(cfg).not.toHaveProperty('enabled');
    expect(parseResearchConfigBody({ enabled: true, timezone: 'UTC', weekday: 2, hour: 10 }, cfg)).toEqual(cfg);
  });

});

describe('sitemap parse', () => {
  it('reads urlset locs', () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://competitor.example/blog/vs-example-product</loc></url>
        <url><loc>https://competitor.example/pricing</loc></url>
      </urlset>`;
    expect(parseSitemapXml(xml).locs).toEqual(['https://competitor.example/blog/vs-example-product', 'https://competitor.example/pricing']);
    expect(parseSitemapXml(xml).nested).toEqual([]);
  });

  it('reads sitemap index children', () => {
    const xml = `<sitemapindex><sitemap><loc>https://x.com/posts.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemapXml(xml).nested).toEqual(['https://x.com/posts.xml']);
    expect(parseSitemapXml(xml).locs).toEqual([]);
  });

  it('turns a slug into a keyword hint', () => {
    expect(keywordHintFromUrl('https://competitor.example/blog/best-competitor-alternative')).toBe('best competitor alternative');
  });

  it('normalizes competitor domains', () => {
    expect(normalizeDomain('https://WWW.Competitor.example/path')).toBe('www.competitor.example');
  });
});
