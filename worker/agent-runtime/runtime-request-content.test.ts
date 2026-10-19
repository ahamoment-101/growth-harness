import { describe, expect, it } from 'vitest';
import { taskTestDb } from './task-test-db';
import { persistRuntimeRequest, readRuntimeJson } from './runtime-content';

function fixture() {
  const f = taskTestDb();
  const stored = () => Number((f.sqlite.prepare('select coalesce(sum(length(value)),0) n from agent_runtime_blobs').get() as { n: number }).n)
    + Number((f.sqlite.prepare('select coalesce(sum(length(value)),0) n from agent_runtime_content_chunks').get() as { n: number }).n);
  return { ...f, stored };
}

describe('request receipts', () => {
  it('reads back the identical payload, including key order, large parts and non-array fields', async () => {
    const f = fixture();
    const wire = { model: 'm', stream: true, max_tokens: 800, system: 's'.repeat(2000), tools: [{ function: { name: 'read', parameters: { type: 'object' } } }],
      messages: [{ role: 'user', content: 'hi' }, { role: 'tool', content: 'x'.repeat(120_000) }, { role: 'user', content: 'hi' }], stream_options: { include_usage: true } };
    const receipt = await persistRuntimeRequest(f.db, wire);
    expect(JSON.stringify(await readRuntimeJson(f.db, receipt))).toBe(JSON.stringify(wire));
  });
  it('stores a growing conversation linearly instead of repeating every earlier message', async () => {
    const f = fixture();
    const tools = Array.from({ length: 10 }, (_, i) => ({ function: { name: `tool_${i}`, description: 'd'.repeat(400) } }));
    const messages: Array<{ role: string; content: string }> = [];
    let full = 0;
    for (let turn = 0; turn < 60; turn++) {
      messages.push({ role: turn % 2 ? 'assistant' : 'user', content: `turn ${turn} `.repeat(150) });
      const wire = { model: 'm', tools, messages: [...messages] };
      full += JSON.stringify(wire).length;
      const receipt = await persistRuntimeRequest(f.db, wire);
      if (turn === 59) expect(await readRuntimeJson(f.db, receipt)).toEqual(wire);
    }
    // Each message and the tool list are stored once; receipts only list references.
    expect(f.stored()).toBeLessThan(full / 20);
  });
  it('keeps plain values and non-object payloads readable', async () => {
    const f = fixture();
    const withGaps = { a: undefined, list: [1, undefined, 3], b: 2 };
    expect(JSON.stringify(await readRuntimeJson(f.db, await persistRuntimeRequest(f.db, withGaps)))).toBe(JSON.stringify(withGaps));
    for (const value of [null, 'text', [1, 2], { a: 1 }]) expect(await readRuntimeJson(f.db, await persistRuntimeRequest(f.db, value))).toEqual(value);
  });
});
