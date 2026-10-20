import { publicHttpUrl } from '../../shared/article-presentation';

const CODE_SPAN_MARK = '\u0000';

/** The Markdown text unit containing a link recognized by the renderer. */
export type MarkdownLinkContext = Readonly<{ anchor: string; source: string }>;
type RewriteHref = (href: string, context: MarkdownLinkContext) => string;

export function markdownToHtml(markdown: string, rewriteHref?: RewriteHref): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const seen = new Set<string>();
  return renderBlocks(lines, rewriteHref).join('\n').replace(/<h([2-6])>(.*?)<\/h\1>/g, (_match, level: string, content: string) => {
    const base = headingAnchor(content);
    let id = base;
    let count = 1;
    while (seen.has(id)) id = `${base}-${++count}`;
    seen.add(id);
    return `<h${level} id="${id}">${content}</h${level}>`;
  });
}

type ListItem = { indent: number; ordered: boolean; content: string };

function matchListItem(line: string | undefined): ListItem | null {
  if (line === undefined) return null;
  const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
  if (!m) return null;
  return { indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), content: m[3] };
}

function isHorizontalRule(line: string): boolean {
  return /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

/** Splits a GFM table row into cells; null when the line is not a pipe row. */
function splitTableRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.includes('|')) return null;
  let body = t;
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isTableDelimiterRow(cells: string[] | null): boolean {
  return !!cells && cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function tableAlignment(delimiter: string[]): Array<'left' | 'center' | 'right' | null> {
  return delimiter.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (left) return 'left';
    if (right) return 'right';
    return null;
  });
}

function matchTable(
  lines: string[],
  start: number,
  rewriteHref?: RewriteHref,
): { html: string; next: number } | null {
  if (start + 1 >= lines.length) return null;
  if (!lines[start].includes('|')) return null;
  const delimiter = splitTableRow(lines[start + 1]);
  if (!isTableDelimiterRow(delimiter)) return null;
  const aligns = tableAlignment(delimiter!);
  const columnCount = delimiter!.length;

  const cellTag = (cell: string, tag: 'th' | 'td', idx: number): string => {
    const align = aligns[Math.min(idx, aligns.length - 1)];
    const attr = align ? ` style="text-align:${align}"` : '';
    return `<${tag}${attr}>${inline(cell, rewriteHref)}</${tag}>`;
  };

  const rowHtml = (cells: string[], tag: 'th' | 'td'): string => {
    const padded = Array.from({ length: columnCount }, (_v, idx) => cells[idx] ?? '');
    return `<tr>${padded.map((cell, idx) => cellTag(cell, tag, idx)).join('')}</tr>`;
  };

  const header = splitTableRow(lines[start]) ?? [];
  const bodyRows: string[][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const cells = splitTableRow(lines[i]);
    if (!lines[i].trim() || !cells || isTableDelimiterRow(cells)) break;
    bodyRows.push(cells);
    i += 1;
  }

  const head = `<thead><tr>${Array.from({ length: columnCount }, (_v, idx) =>
    cellTag(header[idx] ?? '', 'th', idx),
  ).join('')}</tr></thead>`;
  const body = `<tbody>${bodyRows.map((cells) => rowHtml(cells, 'td')).join('')}</tbody>`;
  return { html: `<table>${head}${body}</table>`, next: i };
}

function renderBlocks(lines: string[], rewriteHref?: RewriteHref, depth = 0): string[] {
  if (depth >= 20) return [`<p>${escapeHtml(lines.join(' '))}</p>`];
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1].trim().split(/\s+/)[0].replace(/[^\w+-]/g, '');
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing fence
      const langClass = lang ? ` class="language-${escapeAttr(lang)}"` : '';
      out.push(`<pre><code${langClass}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*> ?/, ''));
      out.push(`<blockquote>${renderBlocks(quote, rewriteHref, depth + 1).join('\n')}</blockquote>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.max(2, heading[1].length);
      out.push(`<h${level}>${inline(heading[2], rewriteHref)}</h${level}>`);
      i += 1;
      continue;
    }

    if (isHorizontalRule(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    const table = matchTable(lines, i, rewriteHref);
    if (table) {
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (matchListItem(line)) {
      const { html, next } = consumeList(lines, i, matchListItem(line)!.indent, rewriteHref);
      out.push(html);
      i = next;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !isHorizontalRule(lines[i]) &&
      !matchTable(lines, i) &&
      !matchListItem(lines[i]) &&
      !/^\s*>/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${inline(para.join(' '), rewriteHref, para)}</p>`);
  }
  return out;
}

// Caps recursion depth so a pathologically deep (AI-generated, uncontrolled) nested list
// degrades to flat siblings instead of overflowing the call stack.
const MAX_LIST_NESTING_DEPTH = 20;

function consumeList(
  lines: string[],
  start: number,
  baseIndent: number,
  rewriteHref?: RewriteHref,
  depth = 0,
): { html: string; next: number } {
  const ordered = matchListItem(lines[start])!.ordered;
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j += 1;
      const peek = matchListItem(lines[j]);
      if (peek && peek.indent === baseIndent && peek.ordered === ordered) {
        i = j;
        continue;
      }
      break;
    }
    const item = matchListItem(lines[i]);
    if (!item || item.indent !== baseIndent || item.ordered !== ordered) break;
    let itemHtml = inline(item.content, rewriteHref);
    i += 1;
    const nested = matchListItem(lines[i]);
    if (nested && nested.indent > baseIndent && depth < MAX_LIST_NESTING_DEPTH) {
      const child = consumeList(lines, i, nested.indent, rewriteHref, depth + 1);
      itemHtml += child.html;
      i = child.next;
    }
    items.push(`<li>${itemHtml}</li>`);
  }
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${items.join('')}</${tag}>`, next: i };
}

export function headingAnchor(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').normalize('NFKC')
    .toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
}

export function firstMarkdownImage(markdown: string): { url: string; alt: string } | undefined {
  const body = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const match of body.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const url = publicHttpUrl(match[2]);
    if (url) return { url, alt: match[1] };
  }
  return undefined;
}

function safeLink(value: string): boolean {
  // Reject schemes before URL rewriting, including control-character obfuscation.
  const cleaned = value.replace(/[\u0000-\u0020\u007f]/g, '');
  return !/^[a-z][a-z0-9+.-]*:/i.test(cleaned) || /^(https?:|mailto:|tel:|article:)/i.test(cleaned);
}

function inline(text: string, rewriteHref?: RewriteHref, sourceLines?: string[]): string {
  const tokens: string[] = [];
  const token = (html: string) => `${CODE_SPAN_MARK}${tokens.push(html) - 1}${CODE_SPAN_MARK}`;
  const cleanSource = text.replace(/\u0000/g, '');
  let result = escapeHtml(cleanSource);
  result = result.replace(/`([^`]+)`/g, (_m, code: string) => token(`<code>${code}</code>`));
  const linkSource = result;
  result = result.replace(/(!?)\[([^\]]*)\]\(([^)]+)\)/g, (_m, image: string, label: string, href: string, offset: number) => {
    const raw = unescapeBasic(href).trim();
    if (image) {
      const url = publicHttpUrl(raw);
      return token(url ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(unescapeBasic(label))}" loading="lazy" decoding="async">` : label);
    }
    if (!safeLink(raw)) return token(label);
    let source = cleanSource;
    if (rewriteHref && sourceLines) {
      // The renderer joins paragraph lines with spaces. Restore only protected
      // code and HTML escapes to map this confirmed match to its original line.
      const prefix = unescapeBasic(linkSource.slice(0, offset).replace(/\u0000(\d+)\u0000/g,
        (_match, index: string) => '`' + tokens[Number(index)].replace(/^<code>|<\/code>$/g, '') + '`'));
      let remaining = prefix.length;
      for (const line of sourceLines) {
        const original = line.replace(/\u0000/g, '');
        if (remaining <= original.length) { source = original; break; }
        remaining -= original.length + 1;
      }
    }
    const url = rewriteHref ? rewriteHref(raw, {
      anchor: unescapeBasic(label.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)].replace(/^<code>|<\/code>$/g, ''))),
      source,
    }) : raw;
    if (!url || !safeLink(url)) return token(label);
    return token(`<a href="${escapeAttr(url)}">${label.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')}</a>`);
  });
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return result.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => tokens[Number(idx)]);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

function unescapeBasic(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
