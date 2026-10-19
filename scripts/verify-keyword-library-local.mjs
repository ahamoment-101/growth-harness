import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

// Real workerd + D1 transaction semantics; no model, network provider or production DB.
const bundled = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'library-local-verifier.ts', contents: `
  import { KeywordLibrary } from './worker/keyword-library/service';
  export default { async fetch(request, env) {
    const input = await request.json();
    const library = new KeywordLibrary(env.DB, { workspace_id:'w', site_id:'s', locale:'pt-BR', market:input.market || 'BR' });
    const context = { operation_id: input.operation, actor:{ type:'human', id:'fixture-user' }, reason:'Local verification' };
    try {
      const result = input.action === 'create' ? await library.create('keyword',input.name,{},context)
        : input.action === 'patch' ? await library.patch(input.id,input.revision,{name:input.name},context)
        : input.action === 'link' ? await library.linkTopic(input.id, input.topic, 'Test coverage',context)
        : input.action === 'logs' ? await library.logs() : await library.detail(input.id);
      return Response.json(result);
    } catch(error) { return Response.json({ error:error.message, details:error.details }, {status:409}); }
  } };
` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-08-18', d1Databases: ['DB'] }));
try {
  const db = await runtime.getD1Database('DB');
  const fixture = `CREATE TABLE sites(id TEXT PRIMARY KEY,workspace_id TEXT); INSERT INTO sites VALUES('s','w'); CREATE TABLE topics(id TEXT PRIMARY KEY,site_id TEXT,title_hint TEXT,status TEXT); INSERT INTO topics VALUES('t1','s','First','queued'),('t2','s','Second','published');`;
  for (const statement of unstable_splitSqlQuery(fixture)) await db.prepare(statement).run();
  for (const statement of unstable_splitSqlQuery(await readFile(new URL('../migrations/0056_keyword_library.sql', import.meta.url), 'utf8'))) await db.prepare(statement).run();
  const call = async (input) => { const r = await runtime.dispatchFetch('http://fixture.invalid', { method: 'POST', body: JSON.stringify(input) }); return { status: r.status, body: await r.json() }; };
  const created = await call({ action: 'create', name: 'email', operation: 'create' });
  assert.equal(created.status, 200);
  assert.deepEqual(await call({ action: 'create', name: 'email', operation: 'create' }), created);
  const id = created.body.target_id;
  const races = await Promise.all(['first', 'second'].map((name) => call({ action: 'patch', name, id, revision: 1, operation: name })));
  assert.equal(races.filter((r) => r.status === 200).length, 1);
  assert.equal((await call({ action: 'logs' })).body.items.length, 2);
  assert.equal((await call({ action: 'read', id, market: 'PT' })).status, 409);
  assert.equal((await call({ action: 'link', id, topic: 't1', revision: 2, operation: 'link1' })).status, 200);
  assert.equal((await call({ action: 'link', id, topic: 't2', revision: 3, operation: 'link2' })).status, 200);
  assert.equal((await call({ action: 'read', id })).body.topics.length, 2);
  await db.prepare("CREATE TRIGGER inject_library_log_failure BEFORE INSERT ON keyword_library_logs BEGIN SELECT RAISE(ABORT,'injected_log_failure'); END;").run();
  assert.equal((await call({ action: 'patch', id, name: 'must rollback', revision: 4, operation: 'fail' })).status, 409);
  const current = (await call({ action: 'read', id })).body.entry;
  assert.equal(current.revision, 4);
  assert.notEqual(current.name, 'must rollback');
  assert.equal((await call({ action: 'logs' })).body.items.length, 4);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  console.log('PASS: real D1 migration, atomic logs, concurrent CAS, idempotent replay, market isolation, multiple topics and failure rollback.');
} finally { await runtime.dispose(); }
