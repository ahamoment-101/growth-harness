import type { D1Database } from '@cloudflare/workers-types';
const INLINE_BYTES = 48 * 1024;
const CHUNK_CHARACTERS = 12000; // At most 48 KB UTF-8, even for non-ASCII documents.
type ContentReference = { $runtime_content: string; characters: number; chunks: number };
export async function persistRuntimeJson(db: D1Database, value: unknown): Promise<string> {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length <= INLINE_BYTES) return json;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const chunks: string[] = [];
  const offsets: number[] = [];
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(json.length, offset + CHUNK_CHARACTERS);
    if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
    offsets.push(offset); chunks.push(json.slice(offset, end)); offset = end;
  }
  for (let i = 0; i < chunks.length; i += 8) await db.batch(chunks.slice(i, i + 8).map((chunk, index) =>
    db.prepare('insert or ignore into agent_runtime_content_chunks(content_id,chunk_index,character_offset,characters,value) values(?,?,?,?,?)').bind(id, i + index, offsets[i + index], chunk.length, chunk)));
  const metadata = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return JSON.stringify({ $runtime_content: id, characters: json.length, chunks: chunks.length,
    ...(metadata.role ? { role: metadata.role } : {}), ...(metadata.stopReason ? { stopReason: metadata.stopReason } : {}) });
}
export async function runtimeJsonText(db: D1Database, stored: string): Promise<string> {
  const value = JSON.parse(stored) as Partial<ContentReference> | null;
  if (!value || typeof value !== 'object' || !value.$runtime_content) return stored;
  const rows = await db.prepare('select value from agent_runtime_content_chunks where content_id=? order by chunk_index')
    .bind(value.$runtime_content).all<{ value: string }>();
  if (rows.results.length !== value.chunks) throw new Error('Durable content is incomplete');
  const text = rows.results.map(row => row.value).join('');
  if (text.length !== value.characters) throw new Error('Durable content length mismatch');
  return text;
}
export async function readRuntimeJson<T = unknown>(db: D1Database, stored: string): Promise<T> {
  const value = JSON.parse(await runtimeJsonText(db, stored)) as unknown;
  return (isRequestManifest(value) ? await resolveRequestManifest(db, value) : value) as T;
}

// Request receipts: each request repeats every earlier message, tool definitions and the system prompt.
// Top-level array elements and long strings are stored once by content hash; the receipt keeps
// references in the original key order, so reading it back yields the identical payload.
type Part = { v: unknown } | { a: string[] } | { s: string };
type RequestManifest = { $runtime_request: 1; fields: Array<[string, Part]> };
const LONG_STRING = 512;
const BLOB_BATCH = 50;
function isRequestManifest(value: unknown): value is RequestManifest {
  return !!value && typeof value === 'object' && (value as { $runtime_request?: unknown }).$runtime_request === 1;
}
async function blobHash(json: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(digest).slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Store a model request receipt with shared parts deduplicated across the Run's requests. */
export async function persistRuntimeRequest(db: D1Database, value: unknown): Promise<string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return persistRuntimeJson(db, value);
  const blobs = new Map<string, string>();
  const put = async (item: unknown) => {
    const json = JSON.stringify(item) ?? 'null'; // JSON arrays hold undefined as null.
    const hash = await blobHash(json);
    if (!blobs.has(hash)) blobs.set(hash, json);
    return hash;
  };
  const fields: Array<[string, Part]> = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || typeof item === 'function') continue; // Omitted by JSON, so omitted from the receipt too.
    if (Array.isArray(item)) fields.push([key, { a: await Promise.all(item.map(put)) }]);
    else if (typeof item === 'string' && item.length > LONG_STRING) fields.push([key, { s: await put(item) }]);
    else fields.push([key, { v: item }]);
  }
  const entries = [...blobs];
  for (let i = 0; i < entries.length; i += BLOB_BATCH) {
    // Large parts (such as saved page text) still go through chunked storage; the blob keeps the reference.
    const rows = await Promise.all(entries.slice(i, i + BLOB_BATCH).map(async ([hash, json]) => [hash, await persistRuntimeJson(db, JSON.parse(json))] as const));
    await db.batch(rows.map(([hash, stored]) => db.prepare('insert or ignore into agent_runtime_blobs(hash,value) values(?,?)').bind(hash, stored)));
  }
  return persistRuntimeJson(db, { $runtime_request: 1, fields } satisfies RequestManifest);
}
async function resolveRequestManifest(db: D1Database, manifest: RequestManifest) {
  const hashes = [...new Set(manifest.fields.flatMap(([, part]) => 'a' in part ? part.a : 's' in part ? [part.s] : []))];
  const stored = new Map<string, string>();
  for (let i = 0; i < hashes.length; i += 500) {
    const rows = await db.prepare('select hash,value from agent_runtime_blobs where hash in (select value from json_each(?))')
      .bind(JSON.stringify(hashes.slice(i, i + 500))).all<{ hash: string; value: string }>();
    for (const row of rows.results) stored.set(row.hash, row.value);
  }
  const part = async (hash: string) => {
    const value = stored.get(hash);
    if (value === undefined) throw new Error('Durable request part is missing');
    return readRuntimeJson(db, value);
  };
  const out: Record<string, unknown> = {};
  for (const [key, item] of manifest.fields) out[key] = 'v' in item ? item.v : 's' in item ? await part(item.s) : await Promise.all(item.a.map(part));
  return out;
}
export async function runtimeJsonPage(db: D1Database, stored: string, offset: number, limit: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset + limit)) {
    throw new Error('Invalid durable content page range');
  }
  const value = JSON.parse(stored) as Partial<ContentReference> | null;
  if (!value || typeof value !== 'object' || !value.$runtime_content) return { text: stored.slice(offset, offset + limit), characters: stored.length };
  const rows = await db.prepare(`select value,character_offset as start,characters from agent_runtime_content_chunks
    where content_id=? and character_offset<? and character_offset+characters>? order by chunk_index`)
    .bind(value.$runtime_content, offset + limit, offset).all<{ value: string; start: number; characters: number }>();
  const end = Math.min(offset + limit, value.characters!);
  let cursor = offset;
  const pieces: string[] = [];
  for (const row of rows.results) {
    if (row.value.length !== row.characters || row.start > cursor || (cursor !== offset && row.start !== cursor)) {
      throw new Error('Durable content page is incomplete or overlapping');
    }
    const next = Math.min(end, row.start + row.characters);
    pieces.push(row.value.slice(cursor - row.start, next - row.start));
    cursor = next;
  }
  if (cursor < end) throw new Error('Durable content page is incomplete');
  return { text: pieces.join(''), characters: value.characters! };
}
