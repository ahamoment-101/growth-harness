import { describe, expect, it } from 'vitest';
import {
  applyLocalePolicyChange,
  articlePath,
  articleUrl,
  blogPostingJsonLd,
  codeFromPrefix,
  defaultPrefixFor,
  headHtml,
  hreflangAlternates,
  homeRedirectUrl,
  listPath,
  listUrl,
  LocalePolicyError,
  localePolicyOf,
  matchBlogPath,
  matchLivePath,
  mergeLocalePolicy,
  paginate,
  totalPages,
  parseLocalePolicy,
  persistableLocalePolicy,
  preferredLocale,
  publicHref,
  renderSitemapDocument,
  robotsTxt,
  sitemapChunks,
  SITEMAP_URL_LIMIT,
  validateLocalePolicy,
} from './seo';
import { INDEXABLE, robotsDirective } from './indexing';

describe('mergeLocalePolicy', () => {
  it('keeps existing prefixes when a colliding language is added later', () => {
    const first = mergeLocalePolicy(['en-US']);
    expect(first.locales).toEqual([{ code: 'en-US', prefix: 'en' }]);
    const next = mergeLocalePolicy(['en-US', 'en-GB'], first);
    expect(next.locales).toEqual([
      { code: 'en-US', prefix: 'en' },
      { code: 'en-GB', prefix: 'en-gb' },
    ]);
  });

  it('uses unique language subtags only for new codes', () => {
    const policy = mergeLocalePolicy(['ja', 'pt-BR']);
    expect(policy.defaultCode).toBe('ja');
    expect(policy.locales).toEqual([
      { code: 'ja', prefix: 'ja' },
      { code: 'pt-BR', prefix: 'pt' },
    ]);
  });
});

describe('validateLocalePolicy / applyLocalePolicyChange', () => {
  it('rejects duplicate prefixes and reserved names', () => {
    expect(
      validateLocalePolicy({
        defaultCode: 'en',
        locales: [
          { code: 'en', prefix: 'blog' },
          { code: 'fr', prefix: 'blog' },
        ],
        redirects: [],
      }).map((i) => i.code),
    ).toContain('prefix_dup');
    expect(
      validateLocalePolicy({
        defaultCode: 'en',
        locales: [{ code: 'en', prefix: 'live' }],
        redirects: [],
      }).map((i) => i.code),
    ).toContain('prefix');
  });

  it('records a 301 history when a prefix is renamed', () => {
    const previous = mergeLocalePolicy(['en', 'pt-BR']);
    const next = applyLocalePolicyChange(previous, {
      defaultCode: 'pt-BR',
      locales: [
        { code: 'en', prefix: 'en' },
        { code: 'pt-BR', prefix: 'br' },
      ],
      redirects: [],
    });
    expect(next.redirects).toEqual([{ fromPrefix: 'pt', toPrefix: 'br' }]);
    expect(matchBlogPath('/pt/blog/ola', next)).toEqual({ kind: 'redirect', pathname: '/br/blog/ola' });
  });

  it('throws on an explicit invalid policy', () => {
    expect(() =>
      persistableLocalePolicy(
        { source_locale: 'en', translate_locales_json: '[]', locale_policy_json: '' },
        { defaultCode: 'en', locales: [{ code: 'en', prefix: 'live' }], redirects: [] },
      ),
    ).toThrow(LocalePolicyError);
  });
});

describe('localePolicyOf', () => {
  it('does not force English when the source locale is something else', () => {
    const policy = localePolicyOf({
      source_locale: 'ja',
      translate_locales_json: '["en"]',
      locale_policy_json: '',
    });
    expect(policy.defaultCode).toBe('ja');
    expect(policy.locales.map((l) => l.code)).toEqual(['ja', 'en']);
  });

  it('honors a stored policy over derived prefixes', () => {
    const policy = parseLocalePolicy(
      JSON.stringify({
        default: 'pt-BR',
        locales: [
          { code: 'pt-BR', prefix: 'br' },
          { code: 'en', prefix: 'en' },
        ],
      }),
    );
    expect(policy?.defaultCode).toBe('pt-BR');
    expect(codeFromPrefix(policy!, 'br')).toBe('pt-BR');
    expect(articlePath(policy!, 'pt-BR', 'ola')).toBe('/br/blog/ola');
  });

  it('adds required published locales without dropping their persisted prefixes later', () => {
    const first = persistableLocalePolicy(
      { source_locale: 'en', translate_locales_json: '[]', locale_policy_json: '' },
      null,
      ['pt-BR'],
    );
    expect(first.locales).toEqual([
      { code: 'en', prefix: 'en' },
      { code: 'pt-BR', prefix: 'pt' },
    ]);
    const later = persistableLocalePolicy(
      {
        source_locale: 'en',
        translate_locales_json: '[]',
        locale_policy_json: JSON.stringify({
          default: first.defaultCode,
          locales: first.locales,
          redirects: first.redirects,
        }),
      },
      null,
      ['pt-BR'],
    );
    expect(later.locales).toEqual(first.locales);
  });

  it('lets settings remove an unpublished locale while preserving published ones', () => {
    const stored = JSON.stringify({
      default: 'en',
      locales: [
        { code: 'en', prefix: 'en' },
        { code: 'fr', prefix: 'fr' },
        { code: 'pt-BR', prefix: 'pt' },
      ],
      redirects: [],
    });
    const policy = persistableLocalePolicy(
      { source_locale: 'en', translate_locales_json: '[]', locale_policy_json: stored },
      null,
      ['pt-BR'],
    );
    expect(policy.locales.map((locale) => locale.code)).toEqual(['en', 'pt-BR']);
    expect(policy.locales.find((locale) => locale.code === 'pt-BR')?.prefix).toBe('pt');
  });
});

describe('preferredLocale', () => {
  const available = ['en', 'pt-BR', 'zh-CN'];

  it('honors quality weights and exact locale matches', () => {
    expect(preferredLocale('en;q=0.7, pt-BR;q=0.9', available, 'en')).toBe('pt-BR');
  });

  it('falls back from a regional request to an available base-language variant', () => {
    expect(preferredLocale('pt-PT, en;q=0.8', available, 'en')).toBe('pt-BR');
  });

  it('uses the default locale for unsupported browser languages', () => {
    expect(preferredLocale('ja-JP', available, 'en')).toBe('en');
  });
});

describe('unique locale identity', () => {
  it('deduplicates BCP-47 codes case-insensitively', () => {
    expect(mergeLocalePolicy(['en', 'pt-BR', 'pt-br']).locales.map((locale) => locale.code)).toEqual(['en', 'pt-BR']);
  });
});

describe('paths and matching', () => {
  const policy = mergeLocalePolicy(['en', 'pt-BR']);

  it('builds list and article paths from prefix, not BCP-47 in the URL', () => {
    expect(listPath(policy, 'en')).toBe('/en/blog');
    expect(listPath(policy, 'pt-BR', 2)).toBe('/pt/blog/page/2');
    expect(articleUrl('https://blog.example.com', policy, 'pt-BR', 'ola')).toBe(
      'https://blog.example.com/pt/blog/ola',
    );
    expect(homeRedirectUrl('https://blog.example.com', policy, ['pt-BR'])).toBe('https://blog.example.com/pt/blog');
  });

  it('matches hosted paths and maps prefix back to locale code', () => {
    expect(matchBlogPath('/', policy)).toEqual({ kind: 'home' });
    expect(matchBlogPath('/robots.txt', policy)).toEqual({ kind: 'robots' });
    expect(matchBlogPath('/sitemap.xml', policy)).toEqual({ kind: 'sitemap' });
    expect(matchBlogPath('/sitemap-2.xml', policy)).toEqual({ kind: 'sitemap', part: 2 });
    expect(matchBlogPath('/en/blog', policy)).toEqual({ kind: 'list', locale: 'en', page: 1 });
    expect(matchBlogPath('/en/blog/page/1', policy)).toEqual({ kind: 'redirect', pathname: '/en/blog' });
    expect(matchBlogPath('/en/blog/page/2', policy)).toEqual({ kind: 'list', locale: 'en', page: 2 });
    expect(matchBlogPath('/pt/blog/ola', policy)).toEqual({ kind: 'article', locale: 'pt-BR', slug: 'ola' });
    expect(matchBlogPath('/pt-BR/blog/ola', policy)).toBeNull();
  });

  it('matches /live/{site} with the same path contract', () => {
    expect(matchLivePath('/live/site-1/pt/blog/ola', policy)).toEqual({
      kind: 'article',
      siteId: 'site-1',
      locale: 'pt-BR',
      slug: 'ola',
    });
  });
});

describe('hreflang, robots, sitemap, schema', () => {
  const policy = mergeLocalePolicy(['en', 'pt-BR']);
  const origin = 'https://blog.example.com';

  it('adds reciprocal alternates plus x-default only for provided pages', () => {
    const alts = hreflangAlternates(
      [{ locale: 'pt-BR', href: articleUrl(origin, policy, 'pt-BR', 'ola') }],
      policy.defaultCode,
      articleUrl(origin, policy, 'pt-BR', 'ola'),
    );
    expect(alts).toEqual([
      { hreflang: 'pt-BR', href: 'https://blog.example.com/pt/blog/ola' },
      { hreflang: 'x-default', href: 'https://blog.example.com/pt/blog/ola' },
    ]);
  });

  it('drops a hreflang cluster that does not contain the page it is attached to', () => {
    expect(
      hreflangAlternates(
        [{ locale: 'en', href: listUrl(origin, policy, 'en') }],
        policy.defaultCode,
        listUrl(origin, policy, 'en', 2),
      ),
    ).toEqual([]);
  });

  it('points robots.txt at the site sitemap', () => {
    expect(robotsTxt(origin)).toContain('Sitemap: https://blog.example.com/sitemap.xml');
  });

  it('closes the preview surface to crawlers instead of advertising a sitemap', () => {
    const preview = robotsTxt(`${origin}/live/site-1`, 'preview');
    expect(preview).toContain('Disallow: /');
    expect(preview).not.toContain('Sitemap:');
  });

  // See docs/publishing.md "URLs, Languages, and Crawling": no crawler-specific training policy is added.
  // The single wildcard group is the decision, not an unfinished feature — and it is also what
  // keeps us safe from the group-merge rule, where one UA named in two groups resolves to Disallow.
  it('gives every crawler the same rule, with no per-bot group', () => {
    const hosted = robotsTxt(origin);
    const agents = [...hosted.matchAll(/^User-agent:\s*(.+)$/gim)].map((line) => line[1].trim());
    expect(agents).toEqual(['*']);
    expect(hosted).not.toContain('Content-Signal');
  });

  it('emits a sitemap index when the URL count exceeds the protocol limit', () => {
    const pages = Array.from({ length: SITEMAP_URL_LIMIT + 1 }, (_, i) => ({
      loc: `https://blog.example.com/en/blog/p-${i}`,
      alternates: [],
    }));
    expect(sitemapChunks(pages)).toHaveLength(2);
    const index = renderSitemapDocument(origin, pages);
    expect(index).toContain('sitemapindex');
    expect(index).toContain('/sitemap-1.xml');
    expect(renderSitemapDocument(origin, pages, 2)).toContain('<urlset');
  });

  it('builds BlogPosting JSON-LD from tenant identity, not a hardcoded brand', () => {
    const json = blogPostingJsonLd({
      title: 'Hello',
      url: 'https://blog.example.com/en/blog/hello',
      locale: 'en',
      datePublished: '2026-08-18T00:00:00.000Z',
      publisherName: 'Acme',
      publisherUrl: 'https://acme.example',
      authorName: 'Acme Editorial',
    });
    expect(json.publisher).toMatchObject({ name: 'Acme', url: 'https://acme.example' });
    expect(json.author).toMatchObject({ name: 'Acme Editorial' });
  });

  it('puts canonical, hreflang and pagination links into the HTML head', () => {
    const html = headHtml({
      lang: 'pt-BR',
      title: 'Olá',
      canonical: 'https://blog.example.com/pt/blog/page/2',
      robots: robotsDirective(INDEXABLE),
      alternates: [],
      ogType: 'website',
      siteName: 'Acme',
      prev: 'https://blog.example.com/pt/blog',
      next: 'https://blog.example.com/pt/blog/page/3',
    });
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('rel="prev"');
    expect(html).toContain('rel="next"');
    expect(html).toContain('content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"');
  });
});

describe('publicHref', () => {
  const policy = mergeLocalePolicy(['en', 'pt-BR']);
  const ctx = {
    origin: 'https://blog.example.com',
    productOrigin: 'https://www.example.com',
    hubPath: '/start',
    hubUrls: { 'pt-BR': 'https://www.example.com/comecar' },
    policy,
    locale: 'pt-BR',
  };

  it('uses per-locale hub URLs and does not invent product-site prefixes', () => {
    expect(publicHref('/start', ctx)).toBe('https://www.example.com/comecar');
    expect(publicHref('/pricing', ctx)).toBe('https://www.example.com/pricing');
  });

  it('keeps blog paths on the blog origin', () => {
    expect(publicHref('/en/blog/hello', ctx)).toBe('https://blog.example.com/en/blog/hello');
  });

  it('leaves relative product links alone when no product origin or hub URL exists', () => {
    expect(publicHref('/start', { ...ctx, productOrigin: '', hubUrls: {} })).toBe('/start');
  });
});

describe('paginate', () => {
  it('slices a list without inventing extra pages', () => {
    const result = paginate(['a', 'b', 'c'], 2, 2);
    expect(result).toEqual({ items: ['c'], page: 2, pages: 2 });
  });
});

describe('totalPages', () => {
  it('is always at least 1, even for an empty locale', () => {
    expect(totalPages(0)).toBe(1);
  });

  it('does not add a page until the count actually spills over', () => {
    expect(totalPages(50, 50)).toBe(1);
    expect(totalPages(51, 50)).toBe(2);
  });
});

describe('defaultPrefixFor', () => {
  it('does not reuse a taken language subtag', () => {
    expect(defaultPrefixFor('en-GB', ['en'])).toBe('en-gb');
  });
});
