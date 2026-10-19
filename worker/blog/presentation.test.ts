import { describe, expect, it } from 'vitest';
import { emptyJob } from '../db';
import type { Site } from '../types';
import { articleVersionSchema } from '../agent-runtime/article-production-tools';
import { articlePresentationPatch } from '../../shared/article-presentation';
import { markdownSubsetIssues } from '../lib/qa';
import { jobVersions, versionsPatch } from '../lib/versions';
import { markdownToHtml } from './markdown';
import { mergeSeoIdentity, openGraphLocale, matchBlogPath, mergeLocalePolicy } from './seo';
import { findLiveArticle, publishedLocalePolicy, renderArticleHtml, renderListHtml, renderSitemapXml } from './render';
import { serveBlog } from './live';

const version = { locale: 'en', slug: 'guide', title: 'Guide', excerpt: 'Visible summary.\n\nMore detail.', content: '## Details\n\nUseful text.' };
const site = {
  id: 's', name: 'Example', domain: 'blog.example.com', source_locale: 'en', product_origin: 'https://example.com',
  hub_path: '/start', locale_policy_json: '', translate_locales_json: '[]', seo_identity_json: '{}', hub_urls_json: '{}',
} as Site;
const makeJob = () => emptyJob({ id: 'j', site_id: 's', status: 'published', published_at: '2026-09-01T00:00:00Z', ...versionsPatch([version]), content_updated_at: '2026-09-02T00:00:00Z' });
const origin = 'https://blog.example.com';
const match = { kind: 'article', locale: 'en', slug: 'guide' } as const;

async function serve(s: Site, headers: Record<string, string> = {}, method = 'GET') {
  const jobs = [makeJob()];
  return serveBlog(new Request(`${origin}/en/blog/guide`, { headers, method }), {} as Env, s, match, true, jobs, publishedLocalePolicy(s, jobs));
}

describe('public presentation contracts', () => {
  it('round-trips authored metadata from the model contract through storage into the actual page', () => {
    const input = articleVersionSchema.parse({ ...version, meta_description: 'A distinct search description.', image_url: 'https://example.com/cover.png', image_alt: 'A comparison chart' });
    const job = emptyJob({ id: 'j', site_id: 's', status: 'published', ...versionsPatch([input]) });
    expect(jobVersions(job)[0]).toMatchObject(input);
    const html = renderArticleHtml(origin, site, findLiveArticle([job], 'en', 'guide')!);
    expect(html).toContain('<meta name="description" content="A distinct search description.">');
    expect(html).toContain('<meta name="twitter:description" content="A distinct search description.">');
    expect(html).toContain('alt="A comparison chart" fetchpriority="high"');
    expect(html).toContain('<meta property="og:image" content="https://example.com/cover.png">');
    expect(html).toContain('"image":"https://example.com/cover.png"');
    expect(html).toContain('Visible summary.');
  });

  it('does not announce a modification date earlier than first publication', () => {
    const job = { ...makeJob(), content_updated_at: '2026-08-01T00:00:00Z' };
    const html = renderArticleHtml(origin, site, findLiveArticle([job], 'en', 'guide')!);
    expect(html).toContain('property="article:modified_time" content="2026-09-01T00:00:00Z"');
    expect(renderSitemapXml(origin, site, [job])).toContain('<lastmod>2026-09-01</lastmod>');
  });

  it('uses a body image or site fallback, including on list pages, without inventing images', () => {
    const s = { ...site, seo_identity_json: '{"defaultOgImage":"https://example.com/default.png"}' };
    expect(renderListHtml(origin, s, [makeJob()], 'en')).toContain('property="og:image" content="https://example.com/default.png"');
    const job = emptyJob({ id: 'j', site_id: 's', status: 'published', ...versionsPatch([{ ...version, content: '![Actual](https://example.com/actual.png)' }]) });
    const html = renderArticleHtml(origin, s, findLiveArticle([job], 'en', 'guide')!);
    expect(html).toContain('property="og:image" content="https://example.com/actual.png"');
    expect(renderArticleHtml(origin, site, findLiveArticle([makeJob()], 'en', 'guide')!)).not.toContain('property="og:image"');
  });

  it('clears config explicitly, preserves unrelated settings, and rejects invalid image URLs', () => {
    const previous = '{"defaultOgImage":"https://example.com/old.png","authorName":"Author"}';
    expect(JSON.parse(mergeSeoIdentity({ defaultOgImage: '' }, previous))).toEqual({ defaultOgImage: '', authorName: 'Author' });
    expect(() => mergeSeoIdentity({ defaultOgImage: '/relative.png' })).toThrow('absolute HTTP(S)');
    expect(() => articlePresentationPatch({ image_url: 'javascript:alert(1)' })).toThrow('HTTP(S)');
    expect(articlePresentationPatch({ image_url: '' })).toEqual({ image_url: '' });
  });

  it('changes the validator when only site configuration changes, while supporting weak tags and HEAD', async () => {
    const initial = await serve(site);
    const tag = initial.headers.get('ETag')!;
    expect((await serve(site, { 'If-None-Match': `W/${tag}` })).status).toBe(304);
    const updated = { ...site, seo_identity_json: '{"defaultOgImage":"https://example.com/new.png"}' };
    const changed = await serve(updated, { 'If-None-Match': tag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('ETag')).not.toBe(tag);
    expect((await serve(updated, { 'If-Modified-Since': '2099-01-01' })).status).toBe(200);
    expect(await (await serve(site, {}, 'HEAD')).text()).toBe('');
    expect((await serve(site, {}, 'POST')).status).toBe(405);
  });

  it('redirects every old slug directly to the current URL and never exposes hidden articles', async () => {
    const job = { ...makeJob(), url_aliases_json: '[{"locale":"en","slug":"old"},{"locale":"en","slug":"older"}]' };
    for (const slug of ['old', 'older']) {
      const response = await serveBlog(new Request(`${origin}/en/blog/${slug}`), {} as Env, site, { ...match, slug }, true, [job], publishedLocalePolicy(site, [job]));
      expect(response.status).toBe(301);
      expect(response.headers.get('Location')).toBe(`${origin}/en/blog/guide`);
    }
    const hidden = { ...job, visibility: 'hidden' as const };
    const response = await serveBlog(new Request(`${origin}/en/blog/old`), {} as Env, site, { ...match, slug: 'old' }, true, [hidden], publishedLocalePolicy(site, [hidden]));
    expect(response.status).toBe(404);
    expect(renderSitemapXml(origin, site, [job])).not.toContain('/blog/old');
  });

  it('renders safe media, quotes and tables with unique navigable section IDs', () => {
    const body = ['# Title', '## Details', '## Details-2', '## Details', '#### Deep', '', '> Quoted evidence', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', '![Chart](https://example.com/a.png)', '', '[Jump](#details)', '', '[unsafe](javascript:alert)', '```js extra-info', 'const x = 1;', '```'].join('\n');
    expect(markdownSubsetIssues('en', body)).toEqual([]);
    const html = markdownToHtml(body);
    expect(html).not.toContain('<h1');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<table>');
    expect(html).toContain('alt="Chart"');
    expect(html).toContain('id="details-3"');
    expect(html).toContain('id="deep"');
    expect(html).toContain('href="#details"');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('const x = 1;');
    expect(markdownToHtml('<script>alert(1)</script>')).not.toContain('<script>');
  });

  it('keeps OG locale separate from hreflang and handles malformed path encoding as not found', () => {
    expect(openGraphLocale('en')).toBe('en_US');
    expect(openGraphLocale('pt-BR')).toBe('pt_BR');
    expect(openGraphLocale('zh-Hant')).toBe('zh_TW');
    expect(openGraphLocale('not_a_locale')).toBeUndefined();
    expect(matchBlogPath('/en/blog/%ZZ', mergeLocalePolicy(['en']))).toBeNull();
    expect(matchBlogPath('/en/blog/page', mergeLocalePolicy(['en']))).toEqual({ kind: 'article', locale: 'en', slug: 'page' });
  });
});
