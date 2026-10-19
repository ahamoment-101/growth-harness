import type { R2Bucket } from '@cloudflare/workers-types';

/** Sparse UTF-8 index. Public offsets retain JavaScript's UTF-16 character units. */
export type SourceTextIndex = {
  encoding: 'utf8-index-v1'; object_key: string; etag: string;
  characters: number; bytes: number; points: Array<{ character: number; byte: number }>;
};
export function indexSourceText(text: string, objectKey: string, etag: string): SourceTextIndex {
  const points = [{ character: 0, byte: 0 }];
  let character = 0; let byte = 0; let last = 0;
  for (const scalar of text) {
    const code = scalar.codePointAt(0)!;
    character += scalar.length;
    byte += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (character - last >= 4096) { points.push({ character, byte }); last = character; }
  }
  if (points.at(-1)!.character !== character) points.push({ character, byte });
  return { encoding: 'utf8-index-v1', object_key: objectKey, etag, characters: character, bytes: byte, points };
}

const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
export function sourceTextPage(text: string, offset: number, limit = 16000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 2) throw new Error('Invalid source page range');
  if (offset > 0 && high(text.charCodeAt(offset - 1)) && low(text.charCodeAt(offset))) throw new Error('Source offset splits a Unicode character');
  let end = Math.min(text.length, offset + limit);
  if (high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end--;
  return { excerpt: text.slice(offset, end), next_offset: end < text.length ? end : null };
}

export async function indexedSourcePage(bucket: R2Bucket, index: SourceTextIndex, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid source offset');
  if (offset >= index.characters) return { excerpt: '', next_offset: null };
  let start = index.points[0];
  for (const point of index.points) {
    if (point.character > Math.max(0, offset - 1)) break;
    start = point;
  }
  const end = index.points.find(point => point.character >= Math.min(index.characters, offset + 16001))!;
  const object = await bucket.get(index.object_key, {
    range: { offset: start.byte, length: end.byte - start.byte }, onlyIf: { etagMatches: index.etag },
  });
  if (!object || !('arrayBuffer' in object)) throw new Error('Evidence snapshot is unavailable or changed');
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== end.byte - start.byte) throw new Error('Evidence byte range is incomplete');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.length !== end.character - start.character) throw new Error('Evidence character range differs from index');
  const result = sourceTextPage(text, offset - start.character);
  const next = offset + result.excerpt.length;
  return { excerpt: result.excerpt, next_offset: next < index.characters ? next : null };
}
