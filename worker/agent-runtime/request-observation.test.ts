import { describe, expect, it } from 'vitest';
import { requestObservation } from './request-observation';
import { taskTestDb } from './task-test-db';
import { readRuntimeJson } from './runtime-content';

describe('serialized request and provider cache evidence', () => {
  it.each([undefined, 0, 700])('distinguishes absent cache metrics from reported %s cached tokens', async cached => {
    const f = taskTestDb();
    const wire = { model:'fixture', tools:[{function:{name:'read'}}], messages:[{role:'system',content:'stable identity'},{role:'user',content:'initial task'}] };
    const usage = { prompt_tokens:1000, ...(cached === undefined ? {} : {prompt_tokens_details:{cached_tokens:cached}}) };
    const text = `data: ${JSON.stringify({usage})}\n\ndata: [DONE]\n\n`;
    const observation = requestObservation(f.db,'task','request',async () => new Response(text,{headers:{'content-type':'text/event-stream'}}));
    await observation.onPayload(wire);
    expect(await (await observation.fetch('https://provider.invalid',{})).text()).toBe(text);
    await observation.commit();
    const row = f.sqlite.prepare('select * from agent_model_request_observations').get()!;
    expect(await readRuntimeJson(f.db,String(row.wire_json))).toEqual(wire);
    expect(JSON.parse(String(row.cache_json))).toEqual(cached === undefined ? {verification:'unavailable'} : {verification:'reported',cache_read_tokens:cached,cache_write_tokens:null});
    const next=requestObservation(f.db,'task','next');
    await next.onPayload({...wire,messages:[...wire.messages,{role:'assistant',content:'progress'}]});
    const rows=f.sqlite.prepare('select prefix_hash,tool_hash from agent_model_request_observations').all();
    expect(rows[0]).toEqual(rows[1]);
  });
});

it.each([
  [{ type: 'message_start', message: { usage: { cache_read_input_tokens: 120, cache_creation_input_tokens: 40 } } },
    { type: 'message_delta', usage: { output_tokens: 5 } }],
  [{ type: 'response.completed', response: { usage: { input_tokens_details: { cached_tokens: 120 } } } },
    { usage: { cache_creation_input_tokens: 40 } }],
])('captures native protocol cache receipts across SSE chunks without erasing earlier metrics', async (...events) => {
  const f = taskTestDb();
  const text = events.map(event => `data:${JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const observation = requestObservation(f.db, 'task', 'native', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17)); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  await observation.onPayload({ model: 'native' });
  expect(await (await observation.fetch('https://provider.invalid', {})).text()).toBe(text);
  await observation.commit();
  const row = f.sqlite.prepare('select cache_json from agent_model_request_observations').get()!;
  expect(JSON.parse(String(row.cache_json))).toEqual({ verification: 'reported', cache_read_tokens: 120, cache_write_tokens: 40 });
});

it.each([
  { system: 'identity', messages: [{ role: 'user', content: 'task' }] },
  { instructions: 'identity', input: [{ role: 'user', content: 'task' }] },
])('includes native system and initial input in stable prefix evidence', async wire => {
  const f = taskTestDb();
  const save = async (id: string, body: unknown) => requestObservation(f.db, 'task', id).onPayload(body);
  await save('first', wire);
  const field = 'system' in wire ? 'system' : 'instructions';
  await save('changed', { ...wire, [field]: 'different identity' });
  const rows = f.sqlite.prepare('select prefix_hash from agent_model_request_observations order by rowid').all();
  expect(rows[0].prefix_hash).not.toBe(rows[1].prefix_hash);
});

it.each(['context_length_exceeded', undefined])('preserves typed provider capacity evidence without classifying message text: %s', async code => {
  const f = taskTestDb();
  const body = JSON.stringify({ error: { code, message: 'context_length_exceeded' } });
  const observation = requestObservation(f.db, 'task', 'request', async () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }));
  expect(await (await observation.fetch('https://provider.invalid', {})).text()).toBe(body);
  expect(observation.errorCode).toBe(code);
});
