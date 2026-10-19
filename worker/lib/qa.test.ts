import { describe, expect, it } from 'vitest';
import { runQa, wordCount } from './qa';

const hub = '/write-english';

const goodEn = [
  'Copy-paste translation keeps your English frozen.',
  '',
  '## Why writing beats translating',
  '',
  'When you write from memory, you actually retrieve the sentence. That is how [write English without copy-paste](/write-english) starts to stick.',
  '',
  '- You notice your own gaps.',
  '- You stop outsourcing the sentence.',
  '',
  '### A small loop',
  '',
  '1. Draft in simple words.',
  '2. Check once.',
  '3. Rewrite **from memory**.',
  '',
  'Use *dictation writing* in the browser instead of `google translate`.',
].join('\n');

const goodPt = [
  'Traduzir com copiar e colar congela o seu inglês.',
  '',
  '## Por que escrever vence traduzir',
  '',
  'Quando você escreve de memória, você recupera a frase. É assim que [escrever inglês sem copiar e colar](/write-english) começa a ficar.',
  '',
  '- Você vê as próprias lacunas.',
  '- Você para de terceirizar a frase.',
  '',
  '### Um loop pequeno',
  '',
  '1. Rascunhe simples.',
  '2. Confira uma vez.',
  '3. Reescreva **de memória**.',
].join('\n');

describe('runQa', () => {
  it('accepts a valid bilingual draft', () => {
    const report = runQa({
      versions: [
        {
          locale: 'en',
          slug: 'example-writer-vs-alternative-writer',
          title: 'Example Writer vs Alternative Writer',
          excerpt: 'A writing loop beats highlighting words.',
          content: goodEn,
        },
        {
          locale: 'pt-BR',
          slug: 'example-writer-vs-alternative-writer-alternativa',
          title: 'Example Writer vs Alternative Writer',
          excerpt: 'Um loop de escrita vence só destacar palavras.',
          content: goodPt,
        },
      ],
      locales: ['en', 'pt-BR'],
      hub_path: hub,
    });
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('accepts English-only when no translations are configured', () => {
    const report = runQa({
      versions: [
        {
          locale: 'en',
          slug: 'write-from-memory',
          title: 'Write from memory',
          excerpt: 'A loop.',
          content: goodEn,
        },
      ],
      locales: ['en'],
      hub_path: hub,
    });
    expect(report.ok).toBe(true);
  });

  it('rejects invalid and copied slugs without enforcing editorial preferences', () => {
    const report = runQa({
      versions: [
        {
          locale: 'en',
          slug: 'Bad_Slug',
          title: 'Title',
          excerpt: '',
          content: '# Hello\n\n[click here](/write-english)\n',
        },
        {
          locale: 'pt-BR',
          slug: 'Bad_Slug',
          title: 'Titulo',
          excerpt: '',
          content: 'pouco',
        },
      ],
      locales: ['en', 'pt-BR'],
      hub_path: hub,
    });
    const codes = report.issues.map((i) => i.code);
    expect(report.ok).toBe(false);
    expect(codes).toContain('en_slug');
    expect(codes).toContain('slug_same');
    expect(codes).not.toContain('min_words');
  });

  it('accepts supported tables and blockquotes but rejects invalid image URLs', () => {
    const body = [
      'Intro [write English](/write-english)',
      '',
      '```js',
      'x',
      '```',
      '',
      '![img](x.png)',
      '',
      '> quote',
      '',
      '| a | b |',
    ].join('\n');
    const report = runQa({
      versions: [
        {
          locale: 'en',
          slug: 'ok-slug',
          title: 'T',
          excerpt: '',
          content: body,
        },
        {
          locale: 'pt-BR',
          slug: 'slug-em-portugues',
          title: 'T',
          excerpt: '',
          content: 'texto [escrever](/write-english)',
        },
      ],
      locales: ['en', 'pt-BR'],
      hub_path: hub,
    });
    const codes = report.issues.map((i) => i.code);
    expect(codes).not.toContain('en_fence_unclosed');
    expect(codes).toContain('en_image_url');
    expect(codes).not.toContain('en_quote');
    expect(codes).not.toContain('en_table');
  });

  it('rejects an unclosed fenced code block', () => {
    const body = ['Intro [write English](/write-english)', '', '```js', 'x = 1'].join('\n');
    const report = runQa({
      versions: [
        { locale: 'en', slug: 'ok-slug', title: 'T', excerpt: '', content: body },
        {
          locale: 'pt-BR',
          slug: 'slug-em-portugues',
          title: 'T',
          excerpt: '',
          content: 'texto [escrever](/write-english)',
        },
      ],
      locales: ['en', 'pt-BR'],
      hub_path: hub,
    });
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('en_fence_unclosed');
  });
});

describe('wordCount', () => {
  it('counts latin words', () => {
    expect(wordCount('Write English from memory today.')).toBe(5);
  });

  it('counts CJK content instead of treating a useful Chinese article as empty', () => {
    expect(wordCount('This is a piece of text used to verify Chinese content length.')).toBeGreaterThan(5);
  });

  it.each(['No product link is relevant here.', '[click here](/write-english)', '[Guide](https://example.com/guide)'])('leaves link selection and anchor quality to editorial judgment: %s', content => {
    expect(runQa({ versions: [{ locale: 'en', slug: 'article', title: 'Article', excerpt: '', content }], locales: ['en'], hub_path: '/write-english' }).ok).toBe(true);
  });

  it('catches the invented sibling link that would have published as a dead link', () => {
    // Verbatim from the rejected production candidate. "escrever em inglês sem
    // tradutor" was a sibling's primary keyword, and the writer turned it into a
    // slug that neither existed nor was going to.
    const report = runQa({
      versions: [{
        locale: 'pt-BR', slug: 'a', title: 'T', excerpt: 'e',
        content: '# T\n\nLead.\n\n## S\n\nVeja [escrever em inglês sem tradutor](https://blog.example.com/pt/blog/escrever-em-ingles-sem-tradutor) e o [guia](https://www.example.com/pt-br/write-english).',
      }] as never,
      locales: ['pt-BR'],
      hub_path: '/write-english',
      hub_urls: { 'pt-BR': 'https://www.example.com/pt-br/write-english' },
      product_origin: 'https://www.example.com',
      blog_origin: 'https://blog.example.com',
      known_article_urls: ['https://blog.example.com/pt-BR/blog/example-writer-vs-alternative-writer'],
      known_article_refs: ['job-sibling-6'],
    });
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain('pt-BR_dead_internal_link');
    // The hub link in the same paragraph is fine and must not be flagged.
    expect(codes).not.toContain('pt-BR_hub_link');
    const message = report.issues.find((issue) => issue.code === 'pt-BR_dead_internal_link')?.message || '';
    expect(message).toContain('read_published_articles');
    expect(message).toContain('article:<job_id>');
  });

  it('accepts a real published url and a sibling reference, and rejects an invented ref', () => {
    const base = {
      locales: ['en'],
      hub_path: '/write-english',
      hub_urls: { en: 'https://www.example.com/en/write-english' },
      product_origin: 'https://www.example.com',
      blog_origin: 'https://blog.example.com',
      known_article_urls: ['https://blog.example.com/en/blog/example-writer-vs-alternative-writer'],
      known_article_refs: ['job-sibling-6'],
    };
    const body = (link: string) => `## T\n\nLead.\n\n## S\n\n${link} and the [guide](/write-english).`;
    const codesFor = (link: string) => runQa({
      ...base,
      versions: [{ locale: 'en', slug: 'a', title: 'T', excerpt: 'e', content: body(link) }] as never,
    }).issues.map((issue) => issue.code);

    expect(codesFor('[comparison](https://blog.example.com/en/blog/example-writer-vs-alternative-writer)')).toEqual([]);
    // A sibling with no slug yet — the only stable way to point at it.
    expect(codesFor('[sibling piece](article:job-sibling-6)')).toEqual([]);
    expect(codesFor('[made up](article:job-does-not-exist)')).toContain('en_unknown_article_ref');
    // An outbound link to somewhere that is not this blog is nobody's business here.
    expect(codesFor('[external](https://example.com/some-page)')).toEqual([]);
  });
});
