import { expect, it } from 'vitest';
import { markdownToHtml, type MarkdownLinkContext } from './markdown';

it('reports only rendered link occurrences, excluding inline code, fenced code, images and unsafe schemes', () => {
  const href = 'https://example.com/product';
  const body = `Use [first](${href}) and [second](${href}).\n\n\`[inline example](${href})\`\n\n\`\`\`markdown\n[fenced example](${href})\n\`\`\`\n\n![image](${href}) [unsafe](javascript:alert)\n\n[after image](${href})`;
  const observed: Array<{ href: string; context: MarkdownLinkContext }> = [];
  const html = markdownToHtml(body, (value, context) => { observed.push({ href: value, context }); return value; });
  expect(observed.map(link => [link.href, link.context.anchor])).toEqual([[href, 'first'], [href, 'second'], [href, 'after image']]);
  expect(observed[0].context.source).toBe(`Use [first](${href}) and [second](${href}).`);
  expect(html.match(/<a href=/g)).toHaveLength(3);
  expect(html).toContain('<code>[inline example]');
  expect(html).toContain('<pre><code class="language-markdown">');
  expect(html).toContain('<img src=');
});

it('supplies the renderer text unit for headings, paragraphs, tables, lists and blockquotes', () => {
  const body = '## Heading [guide](/guide)\n\nRead [details](/details) first.\n\n| Choice | Next |\n| --- | --- |\n| Topic | Try [table](/table) |\n\n- Use [list](/list)\n  - Nested [child](/child)\n\n> See [quote](/quote).';
  const observed: MarkdownLinkContext[] = [];
  markdownToHtml(body, (href, context) => { observed.push(context); return href; });
  expect(observed).toEqual([
    { anchor: 'guide', source: 'Heading [guide](/guide)' },
    { anchor: 'details', source: 'Read [details](/details) first.' },
    { anchor: 'table', source: 'Try [table](/table)' },
    { anchor: 'list', source: 'Use [list](/list)' },
    { anchor: 'child', source: 'Nested [child](/child)' },
    { anchor: 'quote', source: 'See [quote](/quote).' },
  ]);
});

it('keeps existing one-argument URL rewriting and generated HTML unchanged when metadata is observed', () => {
  const body = '## [Guide](/guide)\n\nUse **bold** [A & <B>](/details?a=1&b=2) and `literal`.\n\n| A |\n| --- |\n| [table](/table) |\n\n- [list](/list)\n\n![diagram](https://example.com/a.png)';
  const contexts: MarkdownLinkContext[] = [];
  const legacy = markdownToHtml(body, href => `/en${href}`);
  const observed = markdownToHtml(body, (href, context) => { contexts.push(context); return `/en${href}`; });
  expect(observed).toBe(legacy);
  expect(contexts.map(context => context.anchor)).toEqual(['Guide', 'A & <B>', 'table', 'list']);
  expect(observed).toContain('<a href="/en/details?a=1&amp;b=2">A &amp; &lt;B&gt;</a>');
  expect(markdownToHtml('See [pending](article:pending).', () => '')).toBe('<p>See pending.</p>');
});

it('keeps code-span token markers out of reported anchor context', () => {
  let anchor = '';
  markdownToHtml('Use [the `code` guide](/guide).', (href, context) => { anchor = context.anchor; return href; });
  expect(anchor).toBe('the code guide');
  expect(anchor).not.toContain('\u0000');
});

it('retains the original paragraph line for identical real and code-example anchors after escaping', () => {
  const href = 'https://example.com/product';
  const body = `<tag> & \`[same](${href})\` is a code example.\nThe real [same](${href}) helps here.\nA later [same](${href}) remains a separate occurrence.`;
  const seen: MarkdownLinkContext[] = [];
  markdownToHtml(body, (value, context) => { seen.push(context); return value; });
  expect(seen).toEqual([
    { anchor: 'same', source: `The real [same](${href}) helps here.` },
    { anchor: 'same', source: `A later [same](${href}) remains a separate occurrence.` },
  ]);
});
