import { expect, it } from 'vitest';
import { authorContentLinkContext, contentProductLink, contentLinkCounts, describeContentInternalLinks } from './content-link-policy';

it('describes the same localized configured target used by authors without claiming fetched page contents', () => {
  const policy = { blog_origin: '', product_origin: 'http://127.0.0.1:5402', hub_path: '/live/site',
    hub_urls: { en: 'http://127.0.0.1:5402/live/site/en/blog', fr: 'https://example.com/fr/product' } };
  const context = authorContentLinkContext(policy, ['en', 'fr', 'de', 'en']);
  expect(context.product_targets.map(target => [target.locale, target.link])).toEqual([
    ['en', contentProductLink(policy, 'en')], ['fr', contentProductLink(policy, 'fr')], ['de', 'http://127.0.0.1:5402/live/site'],
  ]);
  expect(context.requirements).toMatchObject({ contract_version: 1, minimum_per_locale: 1, maximum_per_locale: 3, product_page: 'include' });
  expect(context.evidence_scope).toContain('does not establish HTTP reachability');
  expect(context.product_targets.every(target => target.verification === 'site_configuration')).toBe(true);
  expect(contentLinkCounts([{ locale: 'en', content: '[index](http://127.0.0.1:5402/live/site/en/blog)' }], policy))
    .toEqual([{ locale: 'en', internal_links: 1 }]);
});

it('keeps an unconfigured product target absent so the Agent can observe the missing fact', () => {
  expect(authorContentLinkContext({ blog_origin: '', product_origin: '', hub_path: '/', hub_urls: {} }, ['en']).product_targets).toEqual([]);
});

it('describes real occurrences instead of same-URL Markdown examples in code or images', async () => {
  const href = 'https://example.com/product';
  const policy = { blog_origin: '', product_origin: 'https://example.com', hub_path: '/product', hub_urls: {} };
  const content = `Read [first](${href}) before [second](${href}).\n\n\`[inline example](${href})\`\n\n\`\`\`markdown\n[fenced example](${href})\n\`\`\`\n\n![diagram](${href})\n\nKeep [third](${href}).`;
  const links = await describeContentInternalLinks({} as D1Database, { siteId: 's', policy, versions: [{ locale: 'en', content }], siblings: [] });
  expect(links.map(link => [link.anchor_text, link.href, link.target.kind])).toEqual([
    ['first', href, 'product'], ['second', href, 'product'], ['third', href, 'product'],
  ]);
  expect(links[0].sentence).toBe(`Read [first](${href}) before [second](${href}).`);
  expect(links).toHaveLength(contentLinkCounts([{ locale: 'en', content }], policy)[0].internal_links);
});

it('uses rendered heading, table, list and quote contexts without changing target classification', async () => {
  const policy = { blog_origin: '', product_origin: 'https://example.com', hub_path: '/product', hub_urls: {} };
  const content = '## Choose [heading](https://example.com/product)\n\n| Topic | Next |\n| --- | --- |\n| Practice | Read [table](https://example.com/product) |\n\n- Use [list](https://example.com/product)\n\n> See [quote](https://example.com/product).\n\nExternal [source](https://research.example.org/study).';
  const links = await describeContentInternalLinks({} as D1Database, { siteId: 's', policy, versions: [{ locale: 'en', content }], siblings: [] });
  expect(links.map(link => [link.anchor_text, link.sentence])).toEqual([
    ['heading', 'Choose [heading](https://example.com/product)'],
    ['table', 'Read [table](https://example.com/product)'],
    ['list', 'Use [list](https://example.com/product)'],
    ['quote', 'See [quote](https://example.com/product).'],
  ]);
  expect(links.every(link => link.target.kind === 'product')).toBe(true);
  expect(links).toHaveLength(contentLinkCounts([{ locale: 'en', content }], policy)[0].internal_links);
});

it('preserves the actual source line when a code example repeats the same anchor and URL', async () => {
  const href = 'https://example.com/product';
  const policy = { blog_origin: '', product_origin: 'https://example.com', hub_path: '/product', hub_urls: {} };
  const content = `Example & <tag>: \`[same](${href})\`.\nUse [same](${href}) for the actual next step.`;
  const links = await describeContentInternalLinks({} as D1Database, { siteId: 's', policy, versions: [{ locale: 'en', content }], siblings: [] });
  expect(links).toMatchObject([{ anchor_text: 'same', sentence: `Use [same](${href}) for the actual next step.`, target: { kind: 'product' } }]);
  expect(links).toHaveLength(1);
});
