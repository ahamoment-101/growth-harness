import { describe, expect, it, vi } from 'vitest';
import type { R2Bucket } from '@cloudflare/workers-types';
import { taskTestDb } from '../../agent-runtime/task-test-db';
import { agentDefinition } from '../../agent-runtime/definitions';
import { attachTask, requireTask } from '../../agent-runtime/task-store';
import { executionEnvironment } from '../../agent-runtime/execution-context';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution } from '../../agent-runtime/runtime-executions';
import type { RuntimeAgentEnv } from '../../agent-runtime/env';
import { readSourcePage, saveSource } from './evidence';
import { indexSourceText, indexedSourcePage } from './source-pages';

function bucketFixture() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let readBytes = 0;
  const put = vi.fn(async (key: string, value: string) => {
    const bytes = new TextEncoder().encode(value);
    const etag = String(objects.size + 1);
    objects.set(key, { bytes, etag });
    return { etag, size: bytes.length };
  });
  const get = vi.fn(async (key: string, options?: { range?: { offset: number; length: number }; onlyIf?: { etagMatches: string } }) => {
    const object = objects.get(key);
    if (!object) return null;
    if (options?.onlyIf && object.etag !== options.onlyIf.etagMatches) return { etag: object.etag };
    const bytes = options?.range ? object.bytes.slice(options.range.offset, options.range.offset + options.range.length) : object.bytes;
    readBytes += bytes.length;
    return { etag: object.etag, size: object.bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), text: async () => new TextDecoder().decode(bytes) };
  });
  const head = vi.fn(async (key: string) => {
    const object = objects.get(key);
    return object ? { etag: object.etag, size: object.bytes.length } : null;
  });
  return { bucket: { put, get, head } as unknown as R2Bucket, put, get, head, objects, readBytes: () => readBytes };
}

describe('immutable source paging and write reuse', () => {
  it.each(['', 'abc', '﻿Chinese🙂a'.repeat(30000), 'x'.repeat(15999) + '🙂' + 'y'.repeat(20000), 'e\u0301"\\\n'.repeat(20000)])('round-trips Unicode in bounded byte ranges (%#)', async text => {
    const f = bucketFixture(); const object = await f.put('source', text);
    const index = indexSourceText(text, 'source', object.etag);
    let offset: number | null = 0; let restored = '';
    do {
      const page = await indexedSourcePage(f.bucket, index, offset);
      restored += page.excerpt; offset = page.next_offset;
    } while (offset !== null);
    expect(restored).toBe(text);
    for (const [, options] of f.get.mock.calls) expect(options!.range!.length).toBeLessThanOrEqual(100000);
    expect(index.bytes).toBe(new TextEncoder().encode(text).length);
  });

  it('rejects changed snapshots, missing objects and split Unicode offsets', async () => {
    const f = bucketFixture(); const object = await f.put('source', 'a🙂b');
    const index = indexSourceText('a🙂b', 'source', object.etag);
    await expect(indexedSourcePage(f.bucket, index, 2)).rejects.toThrow('Unicode');
    f.objects.get('source')!.etag = 'replaced';
    await expect(indexedSourcePage(f.bucket, index, 0)).rejects.toThrow('changed');
    f.objects.delete('source');
    await expect(indexedSourcePage(f.bucket, index, 0)).rejects.toThrow('unavailable');
  });

  it('deduplicates the exact capture, preserves different bodies, fences writes and rejects foreign reads', async () => {
    const f = taskTestDb(); const storage = bucketFixture();
    const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
    const execution = await createRuntimeExecution(f.db, task.active_run_id);
    await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
    const env = executionEnvironment({ DB: f.db, RESEARCH_BUCKET: storage.bucket } as RuntimeAgentEnv, authorityForExecution(execution));
    const current = await requireTask(env.DB, task.active_run_id);
    const text = 'Chinese🙂'.repeat(50000);
    const source = await saveSource(env, current, 'https://example.com', text);
    expect(await saveSource(env, current, 'https://example.com', text)).toEqual(source);
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect((await saveSource(env, current, 'https://example.com', text + 'revision')).id).not.toBe(source.id);
    expect(storage.put).toHaveBeenCalledTimes(2);
    storage.objects.delete(source.object_key);
    expect((await saveSource(env, current, 'https://example.com', text)).id).toBe(source.id);
    expect(storage.put).toHaveBeenCalledTimes(3);
    let restored = ''; let offset: number | null = 0;
    const before = storage.readBytes();
    do {
      const page = await readSourcePage(env, current, source.id, offset);
      restored += page.excerpt; offset = page.next_offset;
    } while (offset !== null);
    expect(restored).toBe(text);
    expect(storage.readBytes() - before).toBeLessThan(new TextEncoder().encode(text).length * 2);
    await expect(readSourcePage(env, { ...current, id: 'other' }, source.id, 0)).rejects.toThrow('does not belong');
    await f.db.prepare('delete from research_source_indexes where source_id=?').bind(source.id).run();
    expect((await readSourcePage(env, current, source.id, 16000)).excerpt).toBe(text.slice(16000, 32000));
    await f.db.prepare("update agent_tasks set status='cancelled' where id=?").bind(task.id).run();
    await expect(saveSource(env, current, 'https://example.com', 'new')).rejects.toThrow();
    expect(storage.put).toHaveBeenCalledTimes(3);
    f.sqlite.close();
  });
});
