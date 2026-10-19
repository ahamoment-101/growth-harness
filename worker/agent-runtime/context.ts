import type { D1Database } from '@cloudflare/workers-types';
import { sha256 } from '../lib/auth/crypto';
import { redactRuntimeValuePreservingSize } from './protocol';

export type ContextSourceValue = {
  sourceId: string;
  version: string;
  capturedAt: string;
  priority: number;
  value: unknown;
};

export type AssembledContext = {
  manifestHash: string;
  manifest: Array<{
    source_id: string; version: string; captured_at: string; hash: string; bytes: number; truncated: boolean;
  }>;
  values: Record<string, unknown>;
  truncated: boolean;
};

const encoder = new TextEncoder();

export function serializedContextBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? 'null').length;
}

/**
 * Fits one context source inside its declared cap.
 *
 * Every source declares a byte cap and is bounded here, at load time, so the
 * assembled context can never exceed the definition budget. That matters
 * because `assembleContext` drops a source that does not fit and
 * `durable-workflow` fails the Run when a required source was dropped — and
 * every declared source is required. Bounding here turns a Run that dies
 * whenever the strategy document grows into one that reads a marked, shortened
 * copy, and leaves the hard failure to mean what it should: the caps were
 * declared wrong.
 */
export function boundedContextValue(value: unknown, maxBytes: number): unknown {
  if (serializedContextBytes(value) <= maxBytes) return value;
  let preview = JSON.stringify(value) ?? 'null';
  for (;;) {
    const wrapped = { truncated: true, preview_json: preview };
    const bytes = serializedContextBytes(wrapped);
    if (bytes <= maxBytes || !preview.length) return wrapped;
    preview = preview.slice(0, Math.floor(preview.length * Math.min(0.9, maxBytes / bytes)));
  }
}

function isTruncatedValue(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { truncated?: unknown }).truncated === true);
}

export function missingContextSourceIds(
  expected: readonly string[],
  manifest: Array<{ source_id: string }>,
): string[] {
  const present = new Set(manifest.map((item) => item.source_id));
  return expected.filter((sourceId) => !present.has(sourceId));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function assembleContext(sources: ContextSourceValue[], maxBytes = 60_000): Promise<AssembledContext> {
  const unique = new Set<string>();
  const prepared = await Promise.all(sources.map(async (source) => {
    if (!source.sourceId || unique.has(source.sourceId)) throw new Error(`Duplicate or empty context source: ${source.sourceId}`);
    unique.add(source.sourceId);
    const value = redactRuntimeValuePreservingSize(source.value);
    const serialized = stable(value);
    return { source, value, serialized, hash: await sha256(serialized), bytes: new TextEncoder().encode(serialized).length };
  }));
  prepared.sort((a, b) => b.source.priority - a.source.priority || a.source.sourceId.localeCompare(b.source.sourceId));
  let used = 0;
  let truncated = false;
  const selected = prepared.filter((item) => {
    if (used + item.bytes > maxBytes) {
      truncated = true;
      return false;
    }
    used += item.bytes;
    return true;
  });
  const manifest = selected.map((item) => ({
    source_id: item.source.sourceId,
    version: item.source.version,
    captured_at: item.source.capturedAt,
    hash: item.hash,
    bytes: item.bytes,
    truncated: isTruncatedValue(item.value),
  })).sort((a, b) => a.source_id.localeCompare(b.source_id));
  return {
    manifestHash: await sha256(stable(manifest)),
    manifest,
    values: Object.fromEntries(selected.map((item) => [item.source.sourceId, item.value])),
    truncated,
  };
}

export function renderAssembledContextValues(values: Record<string, unknown>): string {
  return Object.keys(values).sort().map((sourceId) => [
    // A header per source: which source this is, and whether what follows is
    // the whole thing. A silently shortened source reads to the model exactly
    // like a source that is genuinely that small.
    `[context:${sourceId}${isTruncatedValue(values[sourceId]) ? ' truncated=true' : ''}]`,
    JSON.stringify(values[sourceId]),
  ].join('\n')).join('\n\n');
}

export async function persistContextSnapshot(
  db: D1Database,
  input: { id: string; runId: string; definitionVersion: number; promptVersion: string; context: AssembledContext; at?: string },
): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  await db.batch([
    db.prepare(
      `insert into agent_context_snapshots (
        id, run_id, definition_version, prompt_version, manifest_hash, manifest_json, truncated, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input.id, input.runId, input.definitionVersion, input.promptVersion, input.context.manifestHash, JSON.stringify(input.context.manifest), input.context.truncated ? 1 : 0, at),
    db.prepare('update agent_runs set context_snapshot_id = ?, updated_at = ? where id = ?').bind(input.id, at, input.runId),
  ]);
}
