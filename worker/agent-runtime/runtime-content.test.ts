import { describe, expect, it } from 'vitest';
import { taskTestDb } from './task-test-db';
import { persistRuntimeJson, readRuntimeJson, runtimeJsonPage } from './runtime-content';

describe('durable Runtime content', () => {
  it('round-trips multi-megabyte Unicode and pages only overlapping chunks', async () => {
    const f = taskTestDb();
    const value = { goal: 'Keep every source', document: 'Chinese 🙂 é'.repeat(260_000), unresolved: ['Verify the last source'] };
    const stored = await persistRuntimeJson(f.db, value);
    expect(stored.length).toBeLessThan(200);
    expect(await readRuntimeJson(f.db, stored)).toEqual(value);
    const count = f.sqlite.prepare('select count(*) as n from agent_runtime_content_chunks').get()!.n;
    await persistRuntimeJson(f.db, value);
    expect(f.sqlite.prepare('select count(*) as n from agent_runtime_content_chunks').get()!.n).toBe(count);
    const offset = 24_001;
    const before = f.counts.statements;
    expect(await runtimeJsonPage(f.db, stored, offset, 137)).toEqual({ text: JSON.stringify(value).slice(offset, offset + 137), characters: JSON.stringify(value).length });
    expect(f.counts.statements - before).toBe(1);
    const chunks = f.sqlite.prepare('select value from agent_runtime_content_chunks').all() as Array<{value:string}>;
    expect(chunks.every((row: {value:string}) => new TextEncoder().encode(row.value).length <= 48 * 1024)).toBe(true);
    expect(chunks.every((row: {value:string}) => !/[\uD800-\uDBFF]$/.test(row.value))).toBe(true);
  });

  it('fails incomplete reads and completes an interrupted immutable write on replay', async () => {
    const f = taskTestDb();
    const value = { document: 'material'.repeat(20_000) };
    const stored = await persistRuntimeJson(f.db, value);
    f.sqlite.exec('delete from agent_runtime_content_chunks where chunk_index=2');
    await expect(readRuntimeJson(f.db, stored)).rejects.toThrow('incomplete');
    await expect(runtimeJsonPage(f.db, stored, 23000, 3000)).rejects.toThrow('incomplete');
    await expect(runtimeJsonPage(f.db, stored, 25000, 100)).rejects.toThrow('incomplete');
    expect(await persistRuntimeJson(f.db, value)).toBe(stored);
    expect(await readRuntimeJson(f.db, stored)).toEqual(value);
    expect((await runtimeJsonPage(f.db, stored, 23000, 3000)).text).toBe(JSON.stringify(value).slice(23000, 26000));
    expect((await runtimeJsonPage(f.db, stored, JSON.stringify(value).length + 1, 100)).text).toBe('');
  });
});
