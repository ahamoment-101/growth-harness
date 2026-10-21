// Real Worker, D1 and Workflow acceptance with absent credentials and no external calls.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const port = Number(process.env.MODEL_CONFIGURATION_PORT || 5298);
const base = `http://127.0.0.1:${port}`;
const bundled = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'model-configuration-verifier.ts', contents: `
  export { AgentRuntimeWorkflow } from './worker/agent-runtime/durable-workflow';
  export { AgentShell } from './worker/agent-runtime/shell';
  export { SiteRoom } from './worker/site-room/room';
  import worker from './worker/index';
  import { createSession, sessionCookie } from './worker/lib/auth/session';
  import { wakeConversation } from './worker/growth-leader/service';
  import { reconcileTaskExecutions } from './worker/agent-runtime/task-recovery';
  export default { async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__fixture/login') {
      const user = await env.DB.prepare("select * from app_users where id='fixture-user'").first();
      const workspace = await env.DB.prepare("select * from workspaces where id='primary-workspace'").first();
      const token = await createSession(env.DB, { user, workspace });
      return new Response(null, { status: 302, headers: { Location: '/website/s', 'Set-Cookie': sessionCookie(url, token) } });
    }
    if (url.pathname === '/__fixture/wake') {
      await wakeConversation(env, { workspaceId: 'primary-workspace', siteId: 's' }, url.searchParams.get('id'));
      return Response.json({ dispatched: true });
    }
    if (url.pathname === '/__fixture/reconcile') {
      await reconcileTaskExecutions(env, new Date(url.searchParams.get('at')));
      return Response.json({ checked: true });
    }
    url.host = '127.0.0.1:${port}'; url.protocol = 'http:';
    const local = new Request(url, request);
    if (local.headers.get('Origin') === 'http://127.0.0.1') local.headers.set('Origin', url.origin);
    return worker.fetch(local, env, ctx);
  } };
` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'], plugins: [{
  name: 'node-path-interop', setup(builder) {
    builder.onResolve({ filter: /^path$/ }, () => ({ path: 'path', namespace: 'builtin-shim' }));
    builder.onLoad({ filter: /.*/, namespace: 'builtin-shim' }, () => ({ contents: "export * from 'node:path';", loader: 'js' }));
  },
}] });
let outboundCalls = 0;
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port, modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: '2026-08-18', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  workflows: { AGENT_WORKFLOW: { name: 'model-configuration', className: 'AgentRuntimeWorkflow' } },
  durableObjects: { AGENT_SHELL: { className: 'AgentShell', useSQLite: true }, SITE_ROOM: { className: 'SiteRoom', useSQLite: true } },
  bindings: { AUTH_LOGIN_METHODS: 'password', AGENT_RUNTIME_ENABLED: 'true' },
  outboundService: async () => { outboundCalls++; return new Response('External calls disabled', { status: 503 }); },
  serviceBindings: { ASSETS: async request => {
    const root = resolve('dist/client');
    let file = resolve(root, '.' + new URL(request.url).pathname);
    if (!file.startsWith(root + '/')) file = resolve(root, 'index.html');
    let bytes;
    try { bytes = await readFile(file); } catch { file = resolve(root, 'index.html'); bytes = await readFile(file); }
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    return new Response(bytes, { headers: { 'content-type': mime[extname(file)] || 'application/octet-stream' } });
  } },
}));
try {
  const db = await runtime.getD1Database('DB');
  const migrationDir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrationDir)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec((await readFile(new URL(file, migrationDir), 'utf8')).replace(/'(?:''|[^'])*'|--[^\n]*/g, part => part.startsWith('--') ? '' : part).replace(/\n/g, ' '));
  }
  await db.prepare("insert into sites(id,name,ingest_url,source_locale,translate_locales_json) values('s','GrowthHarness Demo','https://example.invalid','en','[]')").run();
  await db.prepare("insert into app_users(id,google_sub,email,display_name,created_at,last_login_at) values('fixture-user','synthetic','fixture@example.invalid','Local verifier',datetime('now'),datetime('now'))").run();
  await db.prepare("update workspaces set owner_user_id='fixture-user' where id='primary-workspace'").run();
  const login = await runtime.dispatchFetch(base + '/__fixture/login', { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (path, body) => runtime.dispatchFetch(base + '/api/sites/s/leader/' + path, {
    method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const id = crypto.randomUUID();
  assert.equal((await call('conversations', { id, title: 'Model setup required' })).status, 201);
  const rejected = await call(`conversations/${id}/messages`, { id: crypto.randomUUID(), text: 'Research my next article' });
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).code, 'model_configuration_required');
  assert.equal(await db.prepare('select count(*) n from leader_inputs').first('n'), 0);
  assert.equal(await db.prepare('select count(*) n from agent_runs').first('n'), 0);

  // Reproduce a task durably accepted by an earlier version, before preflight existed.
  await db.prepare("insert into leader_inputs(id,conversation_id,kind,actor_id,content,created_at) values(?,?,'user','fixture-user','Research my next article',?)")
    .bind(crypto.randomUUID(), id, new Date().toISOString()).run();
  const wake = await runtime.dispatchFetch(base + '/__fixture/wake?id=' + id);
  assert.equal(wake.status, 200, await wake.text());
  let detail;
  const deadline = Date.now() + 20000;
  do {
    detail = await (await call(`conversations/${id}`)).json();
    if (detail.conversation.status === 'paused') break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  assert.equal(detail.conversation.status, 'paused');
  assert.match(detail.conversation.reason, /OPENROUTER_API_KEY is not set/);
  const executions = await db.prepare('select count(*) n from agent_runtime_executions').first('n');
  for (const day of [1, 30]) {
    const checked = await runtime.dispatchFetch(base + '/__fixture/reconcile?at=' + encodeURIComponent(new Date(Date.now() + day * 86400000).toISOString()));
    assert.equal(checked.status, 200, await checked.text());
  }
  assert.equal(await db.prepare('select count(*) n from agent_runtime_executions').first('n'), executions);
  assert.equal(await db.prepare('select count(*) n from agent_model_attempts').first('n'), 0);
  assert.equal(outboundCalls, 0);
  console.log(JSON.stringify({ verified: 'missing-key preflight, real Workflow pause, original task retained, no retries after reconciliation', executions, modelAttempts: 0, outboundCalls, login: base + '/__fixture/login', conversation: id }));
  if (process.env.LEADER_UI === '1') await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
} finally { await runtime.dispose(); }
