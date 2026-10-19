import type { ReactNode } from 'react';

export function MarkdownDocument({ markdown }: { markdown: string }) {
  const lines = stripFrontMatter(markdown).replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = inline(heading[2], `h-${index}`);
      blocks.push(level === 1 ? <h1 key={index}>{content}</h1> : level === 2 ? <h2 key={index}>{content}</h2> : level === 3 ? <h3 key={index}>{content}</h3> : <h4 key={index}>{content}</h4>);
      index += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`code-${index}`}><code data-language={language}>{code.join('\n')}</code></pre>);
      continue;
    }
    if (isTableStart(lines, index)) {
      const headers = tableCells(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) rows.push(tableCells(lines[index++]));
      blocks.push(
        <div className="md-table-wrap" key={`table-${index}`}>
          <table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell, `th-${index}-${cellIndex}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inline(row[cellIndex] || '', `td-${index}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*]\s+/, ''));
      blocks.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `uli-${index}-${itemIndex}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*\d+\.\s+/, ''));
      blocks.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `oli-${index}-${itemIndex}`)}</li>)}</ol>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={`quote-${index}`}>{inline(quote.join(' '), `q-${index}`)}</blockquote>);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={`hr-${index}`} />);
      index += 1;
      continue;
    }
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) paragraph.push(lines[index++].trim());
    blocks.push(<p key={`p-${index}`}>{inline(paragraph.join(' '), `p-${index}`)}</p>);
  }
  return <article className="markdown-document">{blocks}</article>;
}

function inline(value: string, key: string): ReactNode[] {
  const pattern = /(\[[^\]]+\]\(https?:\/\/[^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  const parts = value.split(pattern).filter(Boolean);
  return parts.map((part, index) => {
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part);
    if (link) return <a key={`${key}-${index}`} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={`${key}-${index}`}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={`${key}-${index}`}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={`${key}-${index}`}>{part.slice(1, -1)}</em>;
    return part;
  });
}

function stripFrontMatter(value: string): string {
  if (!value.startsWith('---\n')) return value;
  const end = value.indexOf('\n---\n', 4);
  return end >= 0 ? value.slice(end + 5) : value;
}

function isTableStart(lines: string[], index: number): boolean {
  return /^\s*\|.*\|\s*$/.test(lines[index] || '') && /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[index + 1] || '');
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] || '';
  return /^(#{1,4})\s+/.test(line) || line.startsWith('```') || /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line) || /^>\s?/.test(line) || /^---+$/.test(line.trim()) || isTableStart(lines, index);
}
