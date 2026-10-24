import { describe, expect, it } from 'vitest';
import type { Job, Site } from '../types';
import { EMPTY_SITE_GSC, EMPTY_SITE_RESEARCH } from '../types';
import { markdownToHtml } from './markdown';
import {
  findLiveArticle,
  localesWithContent,
  publishedLocalePolicy,
  renderArticleHtml,
  renderFeedXml,
  renderListHtml,
  renderNotFoundHtml,
  renderSitemapXml,
  renderTrialHtml,
} from './render';
import { LIST_PAGE_SIZE, localePolicyFromCodes, matchBlogPath, matchLivePath, publicHref } from './seo';

function site(partial: Partial<Site> = {}): Site {
  return {
    id: 'site-1',
    workspace_id: 'primary-workspace',
    name: 'Example Publishing',
    domain: 'blog.publisher.example.org',
    root_domain: 'publisher.example.org',
    ingest_url: '',
    ingest_secret: '',
    secret_header: 'x-ingest-secret',
    locales_json: '["en"]',
    translate_locales_json: '["pt-BR"]',
    webhook_fields_json: '[]',
    webhook_mode: 'group',
    hub_path: '/write-english',
    product_origin: 'https://www.publisher.example.org',
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
    site_id: 'site-1',
    topic_id: null,
    status: 'published',
    visibility: 'visible',
    translation_group: 'hello',
    category: 'METHOD',
    translate_locales_json: '["pt-BR"]',
    versions_json: JSON.stringify([
      {
        locale: 'en',
        slug: 'hello',
        title: 'Hello',
        excerpt: 'Ex',
        content: 'Practice [write English](/write-english).',
      },
      {
        locale: 'pt-BR',
        slug: 'ola',
        title: 'Olá',
        excerpt: 'Ex',
        content: 'Pratique [escrever inglês](/write-english).',
      },
    ]),
    en_slug: 'hello',
    en_title: 'Hello',
    en_excerpt: 'Ex',
    en_content: 'Practice [write English](/write-english).',
    pt_slug: 'ola',
    pt_title: 'Olá',
    pt_excerpt: 'Ex',
    pt_content: 'Pratique [escrever inglês](/write-english).',
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

describe('markdownToHtml', () => {
  it('renders headings, lists and links', () => {
    const html = markdownToHtml('## Title\n\nA [link](/write-english).\n\n- one\n- two');
    expect(html).toContain('<h2 id="title">Title</h2>');
    expect(html).toContain('<a href="/write-english">link</a>');
    expect(html).toContain('<li>one</li>');
  });

  it('renders bold, italic and inline code', () => {
    const html = markdownToHtml('Rewrite **from memory** using *dictation writing* and `google translate`.');
    expect(html).toContain('<strong>from memory</strong>');
    expect(html).toContain('<em>dictation writing</em>');
    expect(html).toContain('<code>google translate</code>');
  });

  it('renders ordered lists', () => {
    const html = markdownToHtml('1. Draft in simple words.\n2. Check once.\n3. Rewrite.');
    expect(html).toContain('<ol><li>Draft in simple words.</li><li>Check once.</li><li>Rewrite.</li></ol>');
  });

  it('renders a nested list under a bullet item', () => {
    const html = markdownToHtml('- parent\n  - child one\n  - child two\n- sibling');
    expect(html).toBe('<ul><li>parent<ul><li>child one</li><li>child two</li></ul></li><li>sibling</li></ul>');
  });

  it('renders a fenced code block without applying inline markdown inside it', () => {
    const html = markdownToHtml('```js\nconst x = 1; // *not* italic\n```');
    expect(html).toBe('<pre><code class="language-js">const x = 1; // *not* italic</code></pre>');
  });

  it('treats an unclosed fence as consuming the rest of the document', () => {
    const html = markdownToHtml('```js\nconst x = 1;');
    expect(html).toBe('<pre><code class="language-js">const x = 1;</code></pre>');
  });

  it('escapes HTML inside a fenced code block', () => {
    const html = markdownToHtml('```\n<script>alert(1)</script>\n```');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('does not overflow the call stack on a pathologically deep nested list', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `${' '.repeat(i)}- x`);
    expect(() => markdownToHtml(lines.join('\n'))).not.toThrow();
  });

  it('renders --- as a horizontal rule instead of literal text', () => {
    const html = markdownToHtml('Intro paragraph.\n\n---\n\n## Next section');
    expect(html).toContain('<hr>');
    expect(html).not.toContain('---');
  });

  it('does not treat a bold-only line as a horizontal rule', () => {
    const html = markdownToHtml('**Example Writer**');
    expect(html).toBe('<p><strong>Example Writer</strong></p>');
  });

  it('renders a GFM pipe table with header, alignment and body rows', () => {
    const html = markdownToHtml(
      [
        '| Feature | Example Writer | Alternative Writer |',
        '| --- | --- | --- |',
        '| Main focus | Writing from memory | Reading bilingual |',
        '| Free plan | Yes | Yes |',
      ].join('\n'),
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Feature</th>');
    expect(html).toContain('<td>Main focus</td>');
    expect(html).toContain('<th>Alternative Writer</th>');
    expect(html).not.toContain('|');
  });

  it('applies column alignment from the delimiter row', () => {
    const html = markdownToHtml('| A | B |\n| :-- | --: |\n| 1 | 2 |');
    expect(html).toContain('<th style="text-align:left">A</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
  });

  it('applies inline markdown and link rewriting inside table cells', () => {
    const html = markdownToHtml('| Feature | Detail |\n| --- | --- |\n| Guide | [write English](/write-english) and **bold** |', (href) => `/en${href}`);
    expect(html).toContain('<a href="/en/write-english">write English</a>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('does not start a table without a delimiter row', () => {
    const html = markdownToHtml('a | b\nplain text');
    expect(html).toContain('<p>');
    expect(html).not.toContain('<table>');
  });
});

describe('matchLivePath', () => {
  const policy = localePolicyFromCodes(['en', 'pt-BR']);

  it('matches home, article and sitemap', () => {
    expect(matchLivePath('/live/site-1', policy)).toEqual({ kind: 'home', siteId: 'site-1' });
    expect(matchLivePath('/live/site-1/', policy)).toEqual({ kind: 'home', siteId: 'site-1' });
    expect(matchLivePath('/live/site-1/sitemap.xml', policy)).toEqual({ kind: 'sitemap', siteId: 'site-1' });
    expect(matchLivePath('/live/site-1/en/blog/hello', policy)).toEqual({
      kind: 'article',
      siteId: 'site-1',
      locale: 'en',
      slug: 'hello',
    });
    expect(matchLivePath('/live/site-1/en/blog', policy)).toEqual({
      kind: 'list',
      siteId: 'site-1',
      locale: 'en',
      page: 1,
    });
  });
});

describe('live article lookup', () => {
  it('renders nested emphasis from a stored publication with its normal link rewriting', () => {
    const published = job({ versions_json: JSON.stringify([{
      locale: 'en', slug: 'hello', title: 'Hello', excerpt: 'Excerpt',
      content: '**Write *from memory*, then check.**\n\nUse [**the *writing* guide**](/write-english) with `*literal*` text.',
    }]) });
    const html = renderArticleHtml('https://blog.publisher.example.org', site(), findLiveArticle([published], 'en', 'hello')!);
    expect(html).toContain('<p><strong>Write <em>from memory</em>, then check.</strong></p>');
    expect(html).toContain('<a href="https://www.publisher.example.org/write-english"><strong>the <em>writing</em> guide</strong></a>');
    expect(html).toContain('<code>*literal*</code>');
    expect(html).not.toContain('**Write');
  });

  it('returns HTML for a published version with SEO head and rewritten hub link', () => {
    const published = job();
    const hit = findLiveArticle([published], 'en', 'hello');
    expect(hit?.version.title).toBe('Hello');
    const html = renderArticleHtml('https://blog.publisher.example.org', site(), hit!);
    expect(html).toContain('Hello');
    expect(html).toContain('hreflang="pt-BR"');
    expect(html).toContain('hreflang="x-default"');
    expect(html).toContain('https://blog.publisher.example.org/en/blog/hello');
    expect(html).toContain('name="blog-agent-site"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('BlogPosting');
    expect(html).toContain('https://www.publisher.example.org/write-english');
  });

  it('gives list, article, trial and 404 pages the same one-link header and blog footer', () => {
    const withLogo = site({ seo_identity_json: JSON.stringify({ logoUrl: 'https://cdn.example.com/logo.png' }) });
    const pages = [
      renderListHtml('https://blog.example.com', withLogo, [job()], 'en', 1),
      renderArticleHtml('https://blog.example.com', withLogo, findLiveArticle([job()], 'en', 'hello')!),
      renderTrialHtml('https://blog.example.com', withLogo),
      renderNotFoundHtml('https://blog.example.com', withLogo),
    ];
    for (const html of pages) {
      expect(html).toContain('class="site-head"');
      expect(html).toContain('<img src="https://cdn.example.com/logo.png"');
      expect(html).toContain('<main class="wrap">');
      // The header link leaves for the customer's site, so the way back into the blog is the footer's.
      expect(html).toContain('class="site-foot"');
      expect(html).toContain('>All posts</a>');
      expect(html).toContain('>Home</a>');
    }
  });

  it('opens the article with a back link to its own locale index, above the title', () => {
    // A reader arriving from search lands at the top of the page; the footer's index link is a
    // whole article away, so the article needs its own way back into the blog.
    const html = renderArticleHtml('https://blog.example.com', site(), findLiveArticle([job()], 'en', 'hello')!);
    const body = html.slice(html.indexOf('<main class="wrap">'));
    const back = /<p class="back-nav">[\s\S]*?<\/p>/.exec(body)?.[0] ?? '';
    expect(back).toContain('href="https://blog.example.com/en/blog"');
    expect(back).toContain('>Back to blog</span>');
    expect(body.indexOf('class="back-nav"')).toBeLessThan(body.indexOf('<h1 class="article-title">'));
  });

  it('writes the back link in the article\'s own language', () => {
    const html = renderArticleHtml('https://blog.example.com', site(), findLiveArticle([job()], 'pt-BR', 'ola')!);
    expect(html).toContain('>Voltar ao blog</span>');
    expect(html).toContain('href="https://blog.example.com/pt/blog"');
  });

  it('points exactly one header link at the customer site; the locale switcher stays inside the blog', () => {
    const html = renderArticleHtml('https://blog.example.com', site(), findLiveArticle([job()], 'en', 'hello')!);
    const header = /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
    const links = [...header.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]);
    expect(links.filter((href) => href === 'https://www.publisher.example.org')).toHaveLength(1);
    for (const href of links) {
      expect(href === 'https://www.publisher.example.org' || href.startsWith('https://blog.example.com')).toBe(true);
    }
    expect(header).toContain('Example Publishing');
    expect(header).not.toContain('blog.publisher.example.org');
  });

  it('marks the header with the customer favicon when no logo was captured', () => {
    // Most sites never fill in seo_identity.logoUrl, so a logo-only header renders unbranded.
    const html = renderArticleHtml('https://blog.example.com', site(), findLiveArticle([job()], 'en', 'hello')!);
    const header = /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
    expect(header).toContain('<img src="https://www.google.com/s2/favicons?domain=publisher.example.org&amp;sz=64"');
  });

  it('copyrights the page in the page\'s own language, not the global organizationName', () => {
    // organizationName is one global string; on an English page it used to print the Chinese brand.
    const localized = site({
      name_by_locale_json: JSON.stringify({ en: { value: 'The Example Publisher Blog', deleted_at: null } }),
      seo_identity_json: JSON.stringify({ organizationName: 'Example Publishing' }),
    });
    const html = renderArticleHtml('https://blog.example.com', localized, findLiveArticle([job()], 'en', 'hello')!);
    const footer = /<footer[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '';
    const header = /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
    expect(footer).toContain(`© ${new Date().getUTCFullYear()} The Example Publisher Blog`);
    expect(footer).not.toContain('Example Publishing');
    expect(header).toContain('The Example Publisher Blog');
    // The configured entity name still identifies the publisher to search engines.
    expect(html).toContain('"publisher":{"@type":"Organization","name":"Example Publishing"');
  });

  it('frames the content column with the shell rather than nesting the shell inside it', () => {
    const html = renderListHtml('https://blog.example.com', site(), [job()], 'en');
    const shell = /\.site-head \.wrap, \.site-foot \.wrap \{[^}]*max-width: ([\d.]+)rem/.exec(html)?.[1];
    const content = /body\.layout-magazine main\.wrap \{[^}]*max-width: ([\d.]+)rem/.exec(html)?.[1];
    expect(Number(shell)).toBeGreaterThan(Number(content));
  });

  it('falls back to the registrable domain when the site has no configured organization URL', () => {
    const bare = site({ product_origin: '', seo_identity_json: '{}' });
    const html = renderArticleHtml('https://blog.example.com', bare, findLiveArticle([job()], 'en', 'hello')!);
    expect(html).toContain('href="https://publisher.example.org"');
  });

  it('uses one navigation switcher and falls back to a locale list when the article has no translation', () => {
    const englishVersion = JSON.parse(job().versions_json)[0];
    const portugueseVersion = JSON.parse(job().versions_json)[1];
    const englishOnly = job({
      id: 'english-only',
      versions_json: JSON.stringify([englishVersion]),
    });
    const portugueseOnly = job({
      id: 'portuguese-only',
      translation_group: 'portuguese-only',
      versions_json: JSON.stringify([portugueseVersion]),
    });
    const jobs = [englishOnly, portugueseOnly];
    const policy = publishedLocalePolicy(site(), jobs);
    const html = renderArticleHtml(
      'https://blog.example.com',
      site(),
      findLiveArticle(jobs, 'en', 'hello')!,
      {
        policy,
        navigationLocales: localesWithContent(jobs),
      },
    );
    expect(html).toContain('href="https://blog.example.com/en/blog/hello"');
    expect(html).toContain('href="https://blog.example.com/pt/blog?set_locale=pt-BR"');
    expect(html).not.toContain('href="https://blog.example.com/pt/blog/ola"');
    expect(html).not.toContain('class="langs"');
  });

  it('404s unpublished jobs', () => {
    expect(findLiveArticle([job({ status: 'awaiting_review' })], 'en', 'hello')).toBeNull();
  });

  it('404s a published job that has been hidden, but keeps it once made visible again', () => {
    const hidden = job({ visibility: 'hidden' });
    expect(findLiveArticle([hidden], 'en', 'hello')).toBeNull();
    const list = renderListHtml('https://blog.publisher.example.org', site(), [hidden], 'en');
    expect(list).not.toContain('Hello');
    const xml = renderSitemapXml('https://blog.publisher.example.org', site(), [hidden]);
    expect(xml).not.toContain('/en/blog/hello');

    expect(findLiveArticle([job({ visibility: 'visible' })], 'en', 'hello')).not.toBeNull();
  });

  it('lists published titles and builds sitemap urls with xhtml hreflang', () => {
    const list = renderListHtml('https://blog.publisher.example.org', site(), [job()], 'en');
    expect(list).toContain('Hello');
    expect(list).toContain('CollectionPage');
    const xml = renderSitemapXml('https://blog.publisher.example.org', site(), [job()]);
    expect(xml).toContain('/en/blog/hello');
    expect(xml).toContain('/pt/blog/ola');
    expect(xml).toContain('/en/blog</loc>');
    expect(xml).toContain('hreflang="x-default"');
  });

  it('orders the blog list and feed by publish time instead of job creation time', () => {
    const olderPublication = job({
      id: 'created-later',
      published_at: '2026-08-18T00:00:00.000Z',
      created_at: '2026-08-20T00:00:00.000Z',
      versions_json: JSON.stringify([{
        locale: 'en', slug: 'older', title: 'Older publication', excerpt: 'Older', content: 'Older body',
      }]),
    });
    const newerPublication = job({
      id: 'created-earlier',
      published_at: '2026-08-19T00:00:00.000Z',
      created_at: '2026-08-17T00:00:00.000Z',
      versions_json: JSON.stringify([{
        locale: 'en', slug: 'newer', title: 'Newer publication', excerpt: 'Newer', content: 'Newer body',
      }]),
    });

    const html = renderListHtml(
      'https://blog.publisher.example.org',
      site(),
      [olderPublication, newerPublication],
      'en',
    );
    const feed = renderFeedXml('https://blog.publisher.example.org', site(), [olderPublication, newerPublication]);

    expect(html.indexOf('Newer publication')).toBeLessThan(html.indexOf('Older publication'));
    expect(feed.indexOf('Newer publication')).toBeLessThan(feed.indexOf('Older publication'));
  });

  it('keeps every published locale routable even when it was selected only for this content run', () => {
    const sourceOnlySite = site({
      translate_locales_json: '[]',
      locale_policy_json: JSON.stringify({
        default: 'en',
        locales: [{ code: 'en', prefix: 'en' }],
        redirects: [],
      }),
    });
    const published = job();
    const policy = publishedLocalePolicy(sourceOnlySite, [published]);
    expect(matchBlogPath('/pt/blog', policy)).toEqual({ kind: 'list', locale: 'pt-BR', page: 1 });
    expect(matchBlogPath('/pt/blog/ola', policy)).toEqual({ kind: 'article', locale: 'pt-BR', slug: 'ola' });

    const list = renderListHtml('https://blog.example.com', sourceOnlySite, [published], 'en');
    expect(list).toContain('aria-label="Languages"');
    expect(list).toContain('href="https://blog.example.com/pt/blog"');
    expect(list).toContain('hreflang="pt-BR"');

    const article = renderArticleHtml(
      'https://blog.example.com',
      sourceOnlySite,
      findLiveArticle([published], 'en', 'hello')!,
      { policy },
    );
    expect(article).toContain('href="https://blog.example.com/pt/blog/ola"');
    expect(renderSitemapXml('https://blog.example.com', sourceOnlySite, [published])).toContain(
      '<loc>https://blog.example.com/pt/blog/ola</loc>',
    );
  });

  it('renders the article headline full-width with a labeled summary block', () => {
    const html = renderArticleHtml(
      'https://blog.publisher.example.org',
      site(),
      findLiveArticle([job()], 'en', 'hello')!,
    );
    expect(html).toContain('<h1 class="article-title">');
    expect(html).toContain('h1.article-title { max-width: none; }');
    expect(html).toContain('<section class="article-summary">');
    expect(html).toContain('<p class="summary-label">Summary</p>');
  });

  it.each(['zh', 'zh-CN', 'zh-Hant'])('uses English shell copy and dates for %s content', (locale) => {
    const zhSite = site();
    const zhJob = job({
      versions_json: JSON.stringify([{
        locale, slug: 'ni-hao', title: 'Hello', excerpt: 'Excerpt', content: 'Body',
      }]),
    });
    const zhHtml = renderArticleHtml(
      'https://blog.publisher.example.org',
      zhSite,
      findLiveArticle([zhJob], locale, 'ni-hao')!,
    );
    expect(zhHtml).toContain('<p class="summary-label">Summary</p>');
    expect(zhHtml).toContain('Back to blog');
    expect(zhHtml).toContain('All posts');
    expect(zhHtml).toContain('>Home</a>');
    expect(zhHtml).toContain('August 18, 2026');
    expect(zhHtml).toContain(`lang="${locale}"`);
    expect(zhHtml).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('falls back to English summary labels for uncovered locales', () => {
    const xxJob = job({
      versions_json: JSON.stringify([{
        locale: 'xx', slug: 'hello', title: 'Hi', excerpt: 'Ex', content: 'Body.',
      }]),
    });
    const xxHtml = renderArticleHtml(
      'https://blog.publisher.example.org',
      site(),
      findLiveArticle([xxJob], 'xx', 'hello')!,
    );
    expect(xxHtml).toContain('<p class="summary-label">Summary</p>');
  });

  it('renders a trial page when there are no published articles', () => {
    const html = renderTrialHtml('https://blog.publisher.example.org', site());
    expect(html).toContain('Hosting check');
    expect(html).toContain('blog.publisher.example.org');
    expect(html).toContain('name="blog-agent-site"');
    expect(html).toContain('noindex');
  });

  it('injects google-site-verification meta when token is set', () => {
    const html = renderTrialHtml('https://blog.publisher.example.org', site({ gsc_verification_meta_token: 'token-123' }));
    expect(html).toContain('name="google-site-verification"');
    expect(html).toContain('content="token-123"');
  });

  it('does not inject google-site-verification meta when token is empty', () => {
    const html = renderTrialHtml('https://blog.publisher.example.org', site());
    expect(html).not.toContain('name="google-site-verification"');
  });

  it('renders customer-domain URLs without /live', () => {
    const html = renderListHtml('https://blog.publisher.example.org', site(), [job()], 'en');
    expect(html).toContain('https://blog.publisher.example.org/en/blog/hello');
    expect(html).not.toContain('/live/');
  });

  it('keeps empty list pages out of the sitemap and marks them noindex', () => {
    const html = renderListHtml('https://blog.example.com', site(), [], 'en');
    expect(html).toContain('noindex');
    const xml = renderSitemapXml('https://blog.example.com', site(), []);
    expect(xml).not.toContain('/en/blog</loc>');
  });

  it('rewrites hub links with per-locale product URLs, not blog prefixes', () => {
    const html = renderArticleHtml(
      'https://blog.example.com',
      site({
        hub_urls_json: JSON.stringify({ 'pt-BR': 'https://www.example.com/comecar' }),
      }),
      findLiveArticle([job()], 'pt-BR', 'ola')!,
    );
    expect(html).toContain('https://www.example.com/comecar');
    expect(html).not.toContain('/pt/write-english');
  });

  it('uses content_updated_at for dateModified instead of job.updated_at', () => {
    const html = renderArticleHtml(
      'https://blog.example.com',
      site(),
      findLiveArticle(
        [job({ updated_at: '2026-12-01T00:00:00.000Z', content_updated_at: '2026-08-18T00:00:00.000Z' })],
        'en',
        'hello',
      )!,
    );
    expect(html).toContain('"dateModified":"2026-08-18T00:00:00.000Z"');
    expect(html).not.toContain('2026-12-01');
  });

  it('uses an explicit locale policy instead of derived prefixes', () => {
    const custom = site({
      locale_policy_json: JSON.stringify({
        default: 'pt-BR',
        locales: [
          { code: 'pt-BR', prefix: 'br' },
          { code: 'en', prefix: 'en' },
        ],
      }),
    });
    const html = renderArticleHtml('https://blog.example.com', custom, findLiveArticle([job()], 'pt-BR', 'ola')!);
    expect(html).toContain('https://blog.example.com/br/blog/ola');
    expect(html).toContain('hreflang="x-default"');
    expect(matchBlogPath('/br/blog/ola', localePolicyFromCodes(['en']))).toBeNull();
  });
});

describe('blog layout templates', () => {
  it('renders the magazine list as editorial cards with a featured first post', () => {
    const html = renderListHtml('https://blog.example.com', site(), [job()], 'en');
    expect(html).toContain('layout-magazine');
    expect(html).toContain('class="post-card featured"');
    expect(html).toContain('class="post-tag">Method</span>');
    expect(html).toContain('class="eyebrow">Blog</p>');
    expect(html).toContain('<time datetime="2026-08-18T00:00:00.000Z">August 18, 2026</time>');
    expect(html).not.toContain('<li><a href=');
    expect(html).not.toContain('class="card hero"');
    expect(html).not.toContain('<body class="layout-classic">');
    expect(html).not.toContain('<body class="layout-timeline">');
  });

  it('renders a retired or unknown stored layout as magazine', () => {
    for (const blog_layout of ['classic', 'timeline', 'grid-hero']) {
      const html = renderListHtml('https://blog.example.com', site({ blog_layout }), [job()], 'en');
      expect(html).toContain('layout-magazine');
      expect(html).toContain('class="post-card featured"');
    }
  });

  it('renders a branded empty home as a magazine placeholder', () => {
    const html = renderTrialHtml('https://blog.example.com', site());
    expect(html).toContain('placeholder-card');
    expect(html).toContain('Hosting check');
    expect(html).toContain('blog.example.com');
    expect(html).toContain('noindex');
    expect(html).not.toContain('class="posts timeline"');
    expect(html).not.toContain('<p class="empty-note">');
  });

  it('shares the branded shell on article and not-found pages', () => {
    const article = renderArticleHtml('https://blog.example.com', site(), findLiveArticle([job()], 'en', 'hello')!);
    expect(article).toContain('site-head');
    expect(article).toContain('site-foot');
    const missing = renderNotFoundHtml('https://blog.example.com', site());
    expect(missing).toContain('site-head');
    expect(missing).toContain('noindex');
  });
});

describe('indexability contract', () => {
  const origin = 'https://blog.example.com';
  /** One locale only, one page past the list limit. */
  const manyEnglishOnly = Array.from({ length: LIST_PAGE_SIZE + 1 }, (_, i) =>
    job({
      id: `j-${i}`,
      translation_group: `g-${i}`,
      translate_locales_json: '[]',
      versions_json: JSON.stringify([
        { locale: 'en', slug: `post-${i}`, title: `Post ${i}`, excerpt: 'Ex', content: 'Body.' },
      ]),
    }),
  );

  function head(html: string): string {
    return html.slice(0, html.indexOf('</head>'));
  }

  it('keeps deeper list pages indexable so their articles stay linked', () => {
    const second = renderListHtml(origin, site(), manyEnglishOnly, 'en', 2);
    expect(head(second)).toContain('content="index, follow');
    expect(head(second)).toContain('<link rel="canonical" href="https://blog.example.com/en/blog/page/2">');
    expect(head(second)).toContain('rel="prev"');
  });

  it('drops hreflang on deeper list pages rather than emitting a cluster without them', () => {
    const both = [job()];
    expect(head(renderListHtml(origin, site(), both, 'en', 1))).toContain('hreflang="pt-BR"');
    expect(head(renderListHtml(origin, site(), manyEnglishOnly, 'en', 2))).not.toContain('hreflang=');
  });

  it('holds the whole preview surface out of the index', () => {
    const article = renderArticleHtml(origin, site(), findLiveArticle([job()], 'en', 'hello')!, {
      surface: 'preview',
    });
    expect(head(article)).toContain('content="noindex, follow"');
    expect(head(article)).not.toContain('application/ld+json');
    const list = renderListHtml(origin, site(), [job()], 'en', 1, { surface: 'preview' });
    expect(head(list)).toContain('content="noindex, follow"');
  });

  it('marks a locale with no published article noindex and gives it no alternates', () => {
    const html = renderListHtml(origin, site(), [], 'en');
    expect(head(html)).toContain('content="noindex, follow"');
    expect(head(html)).not.toContain('hreflang=');
  });

  it('describes an article with both BlogPosting and BreadcrumbList', () => {
    const html = renderArticleHtml(origin, site(), findLiveArticle([job()], 'en', 'hello')!);
    expect(html).toContain('"@type":"BlogPosting"');
    expect(html).toContain('"@type":"BreadcrumbList"');
    expect(html).toContain('"item":"https://blog.example.com/en/blog/hello"');
  });

  it('announces the sibling locales to social crawlers as well', () => {
    const html = renderArticleHtml(origin, site(), findLiveArticle([job()], 'en', 'hello')!);
    expect(head(html)).toContain('<meta property="og:locale" content="en_US">');
    expect(head(html)).toContain('<meta property="og:locale:alternate" content="pt_BR">');
  });

  it('never puts a URL in the sitemap under a hreflang cluster that excludes it', () => {
    const xml = renderSitemapXml(origin, site(), [job()]);
    const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const loc = /<loc>([^<]+)<\/loc>/.exec(entry)?.[1] ?? '';
      const hrefs = [...entry.matchAll(/xhtml:link[^>]*href="([^"]+)"/g)].map((m) => m[1]);
      if (hrefs.length) expect(hrefs).toContain(loc);
    }
  });

  it("favicons the customer's own logo when one has been captured", () => {
    const withLogo = site({ seo_identity_json: JSON.stringify({ logoUrl: 'https://cdn.example.com/logo.png' }) });
    const html = renderArticleHtml(origin, withLogo, findLiveArticle([job()], 'en', 'hello')!);
    expect(head(html)).toContain('<link rel="icon" href="https://cdn.example.com/logo.png">');
  });

  it('falls back to the customer\'s real-domain favicon lookup when no logo was captured', () => {
    const html = renderArticleHtml(origin, site(), findLiveArticle([job()], 'en', 'hello')!);
    expect(head(html)).toContain(
      '<link rel="icon" href="https://www.google.com/s2/favicons?domain=publisher.example.org&amp;sz=64">',
    );
  });

  it('describes the site as one Organization, reusing the same logo and identity everywhere', () => {
    const withLogo = site({ seo_identity_json: JSON.stringify({ logoUrl: 'https://cdn.example.com/logo.png' }) });
    const list = renderListHtml(origin, withLogo, [job()], 'en');
    expect(list).toContain('"@type":"Organization"');
    expect(list).toContain('"logo":{"@type":"ImageObject","url":"https://cdn.example.com/logo.png"}');
    const article = renderArticleHtml(origin, withLogo, findLiveArticle([job()], 'en', 'hello')!);
    expect(article).toContain('"logo":{"@type":"ImageObject","url":"https://cdn.example.com/logo.png"}');
  });

  it('resolves a sibling reference to this locale, and drops the link when it is not live', () => {
    const ctx = {
      origin: 'https://blog.example.com',
      productOrigin: 'https://www.example.com',
      hubPath: '/write-english',
      hubUrls: { en: 'https://www.example.com/en/write-english' },
      policy: { locales: [{ code: 'en', prefix: 'en' }], redirects: [], defaultCode: 'en' },
      locale: 'en',
      articleUrlsByJob: { 'job-6': 'https://blog.example.com/en/blog/sibling-slug' },
    } as never;
    const rewrite = (href: string) => publicHref(href, ctx);

    // Live: the reference becomes that article's URL in the reader's language.
    expect(markdownToHtml('See [the sibling](article:job-6).', rewrite))
      .toContain('href="https://blog.example.com/en/blog/sibling-slug"');
    // Not live yet: the sentence keeps its words and loses only the link, rather
    // than rendering href="" and sending the reader back to this same page.
    const unresolved = markdownToHtml('See [the sibling](article:job-missing).', rewrite);
    expect(unresolved).toContain('the sibling');
    expect(unresolved).not.toContain('<a');
  });
});
