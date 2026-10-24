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

it.each([
  ['**outer *inner* outer**', '<strong>outer <em>inner</em> outer</strong>'],
  ['*outer **inner** outer*', '<em>outer <strong>inner</strong> outer</em>'],
  ['***both***', '<em><strong>both</strong></em>'],
  ['**strong and *both***', '<strong>strong and <em>both</em></strong>'],
  ['***both* and strong**', '<strong><em>both</em> and strong</strong>'],
  ['a***b***c', 'a<em><strong>b</strong></em>c'],
  ['a*😀*b', 'a<em>😀</em>b'],
  ['**one** and **two**', '<strong>one</strong> and <strong>two</strong>'],
])('renders nested emphasis without leaking delimiters: %s', (source, expected) => {
  expect(markdownToHtml(source)).toBe(`<p>${expected}</p>`);
});

it.each([
  ['**unclosed', '**unclosed'],
  ['unopened**', 'unopened**'],
  ['** spaced **', '** spaced **'],
  ['literal * and * punctuation', 'literal * and * punctuation'],
  ['**outer *inner*', '**outer <em>inner</em>'],
  ['a**b*c', 'a**b*c'],
  ['a*$*b', 'a*$*b'],
])('keeps unmatched or non-emphasis markers literal: %s', (source, expected) => {
  expect(markdownToHtml(source)).toBe(`<p>${expected}</p>`);
});

it('honors escaped asterisks and backslashes without parsing code-span contents', () => {
  expect(markdownToHtml(String.raw`Literal \*stars\* and **bold \*literal\* with *inner***.`))
    .toBe('<p>Literal *stars* and <strong>bold *literal* with <em>inner</em></strong>.</p>');
  expect(markdownToHtml('A \\\\*word* and `**code \\*literal\\***`.'))
    .toBe('<p>A \\<em>word</em> and <code>**code \\*literal\\***</code>.</p>');
  expect(markdownToHtml('**before `*literal*` after**'))
    .toBe('<p><strong>before <code>*literal*</code> after</strong></p>');
});

it('renders nested link-label emphasis while preserving rewrite context and protected code', () => {
  const seen: MarkdownLinkContext[] = [];
  const source = 'An introductory line.\nRead [**outer *inner* and `*code*`**](/guide?a=1&b=2).';
  const html = markdownToHtml(source, (href, context) => { seen.push(context); return `/en${href}`; });
  expect(html).toContain('<a href="/en/guide?a=1&amp;b=2"><strong>outer <em>inner</em> and <code>*code*</code></strong></a>');
  expect(html).not.toContain('\u0000');
  expect(seen).toEqual([{
    anchor: '**outer *inner* and *code***',
    source: 'Read [**outer *inner* and `*code*`**](/guide?a=1&b=2).',
  }]);
});

it('keeps nested emphasis from bypassing HTML escaping or unsafe-link rejection', () => {
  const html = markdownToHtml('**outer *<script>* outer** [**unsafe *label***](javascript:alert)');
  expect(html).toContain('<strong>outer <em>&lt;script&gt;</em> outer</strong>');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<a');
  expect(html).not.toContain('javascript:');
});

it('handles long delimiter runs and unmatched candidates without recursive nesting', () => {
  const markers = '*'.repeat(2000);
  const html = markdownToHtml(`Before ${markers}nested${markers} after.`);
  expect(html.match(/<strong>/g)).toHaveLength(1000);
  expect(html.match(/<\/strong>/g)).toHaveLength(1000);
  expect(html).not.toContain('*');
  const ambiguous = 'Before ' + '*a '.repeat(2000) + 'a**b**c '.repeat(2000) + 'after.';
  expect(markdownToHtml(ambiguous)).toContain('after.</p>');
});
