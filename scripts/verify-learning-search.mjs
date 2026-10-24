import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { learningAcceptanceConfig } from './learning-acceptance-config.ts';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { corpus, relevanceCases } from './fixtures/learning-search-cases.mjs';

if (process.env.VERIFY_REAL_RUNTIME !== '1') throw new Error('Use VERIFY_REAL_RUNTIME=1 for real embeddings and Vectorize on a synthetic isolated corpus.');
const root = resolve(process.env.LEARNING_STATE || '.wrangler/learning-search-acceptance');
await mkdir(root, { recursive: true });
const { vars, accountId, apiToken } = learningAcceptanceConfig(process.env.VERIFY_LEADER === '1');
if (!accountId || !apiToken) throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for the isolated Vectorize acceptance.');
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
let index;
try { index = JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8')); } catch { /* First isolated run. */ }
if (index && !index.deleted && index.account_id !== accountId) throw new Error('Acceptance state belongs to another account; use a new LEARNING_STATE directory.');
if (!index || index.deleted) {
  const name = 'learning-recall-acceptance-' + Date.now();
  const response = await fetch(base + '/vectorize/v2/indexes', { method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: 'Isolated synthetic learning acceptance', config: { dimensions: 1024, metric: 'cosine' } }) });
  const result = await response.json();
  if (!result.success) throw new Error('Cannot provision isolated acceptance index: HTTP ' + response.status);
  index = { name, account_id: accountId, created_at: new Date().toISOString(), state_path: resolve(root, name) };
  await writeFile(resolve(root, 'index.json'), JSON.stringify(index, null, 2));
}
const { name } = index;
if (!name.startsWith('learning-recall-acceptance-')) throw new Error('Only the isolated acceptance index is allowed');
const stats = { embeddings: 0, vector_queries: 0, upserts: 0, confirmations: 0 };
let runtime;
let verificationError;
try {
const bundled = await build({ entryPoints: ['scripts/fixtures/learning-search-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
  external: ['cloudflare:*', 'node:*'], plugins: [{ name: 'node-path', setup(b) {
    b.onResolve({ filter: /^path$/ }, () => ({ path: 'path', namespace: 'shim' }));
    b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: "export * from 'node:path';", loader: 'js' }));
  } }],
});
runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: Number(process.env.LEARNING_SEARCH_PORT || 5214),
  modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-08-18', compatibilityFlags: ['nodejs_compat'],
  resourcePersistencePath: index.state_path || resolve(root, 'local-state'), d1Databases: ['DB'], r2Buckets: ['RESEARCH_BUCKET'],
  durableObjects: { AGENT_SHELL: { className: 'AgentShell', useSQLite: true }, SITE_ROOM: { className: 'SiteRoom', useSQLite: true } },
  workflows: { AGENT_WORKFLOW: { name: 'semantic-acceptance-runtime', className: 'AgentRuntimeWorkflow' } },
  bindings: { ...vars, AGENT_RUNTIME_ENABLED: 'true' },
  serviceBindings: { LIVE_SEARCH: async (request) => {
    const method = new URL(request.url).pathname.slice(1), body = await request.json();
    let path, payload, contentType = 'application/json';
    if (method === 'embed') { path = '/ai/run/' + body.model; payload = JSON.stringify(body.input); stats.embeddings++; }
    else {
      path = `/vectorize/v2/indexes/${name}/${method}`;
      if (method === 'upsert') {
        payload = new FormData();
        payload.append('vectors', new Blob([body.map((v) => JSON.stringify(v)).join('\n') + '\n'], { type: 'application/x-ndjson' }), 'vectors.ndjson');
        contentType = null; stats.upserts++;
      }
      else { payload = JSON.stringify(body); if (method === 'query') stats.vector_queries++; if (method === 'get_by_ids') stats.confirmations++; }
    }
    const result = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, ...(contentType ? { 'Content-Type': contentType } : {}) }, body: payload, signal: AbortSignal.timeout(60000) });
    const data = await result.json();
    if (!data.success) { console.error('Isolated provider request failed', method, result.status, data.errors?.map((e) => ({ code: e.code, message: e.message }))); return Response.json({ error: 'provider failure' }, { status: 502 }); }
    return Response.json(data.result);
  } },
  outboundService: async (request) => {
    const headers = new Headers(request.headers);
    for (const key of ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding']) headers.delete(key);
    return fetch(request.url, { method: request.method, headers, signal: request.signal,
      ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) });
  },
}));
const post = async (path, body = {}) => {
  const response = await runtime.dispatchFetch('http://localhost' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Acceptance route ${path} failed: ${await response.text()}`);
  return response.json();
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let report = { created_at: new Date().toISOString(), source: 'synthetic business records; real Workers AI BGE-M3 and Cloudflare Vectorize; local D1 and Worker', index: name, cases: [] };
  const db = await runtime.getD1Database('DB');
  await db.exec('create table if not exists acceptance_migrations(name text primary key);');
  for (const file of (await readdir('migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    if (await db.prepare('select 1 from acceptance_migrations where name=?').bind(file).first()) continue;
    await db.exec((await readFile('migrations/' + file, 'utf8')).replace(/'(?:''|[^'])*'|--[^\n]*/g, (p) => p.startsWith('--') ? '' : p).replace(/\n/g, ' '));
    await db.prepare('insert into acceptance_migrations values(?)').bind(file).run();
  }
  await db.prepare("insert or ignore into sites(id,name,ingest_url,source_locale,translate_locales_json) values('semantic-site','Synthetic semantic learning acceptance','https://example.invalid/','en','[]')").run();
  for (const [key, text] of Object.entries({
    product: 'Synthetic educational guide to workplace email. No paid products or customer outcomes are known.',
    audience: 'English-speaking professionals responding to difficult requests, unrealistic delivery dates and disagreements.',
    marketing: 'A synthetic pilot targets 10 GSC clicks in 7 publication days per article. It is not a forecast. Discovery clicks are not conversions.',
    brand: 'Practical, calm and context-sensitive. Never promise outcomes.', conversion: 'No conversion measurement exists.',
    competition: 'Historical lessons cover multiple experiments. Applicability is a judgment, not a similarity cutoff.',
  })) await db.prepare("insert or ignore into business_module_versions(id,site_id,module_key,version,content_json,markdown,source) values(?,'semantic-site',?,1,?,?,'manual')").bind('semantic-' + key, key, JSON.stringify({ summary: text }), text).run();
  const drain = async () => {
    for (let pass = 0; pass < 60; pass++) {
      const state = await post('/index');
      const unfinished = await db.prepare("select count(*) as n from learning_search_jobs j join learning_search_sources s on s.record_id=j.record_id and s.generation=j.generation where j.state!='ready'").first();
      console.log('Index pass', pass, state.coverage);
      if (state.coverage.complete && unfinished.n === 0) return state.coverage;
      await pause(5500);
    }
    throw new Error('Index did not reach confirmed visibility');
  };
  if (process.env.VERIFY_LEADER_ONLY !== '1' && process.env.VERIFY_INDEX_ONLY !== '1') {
  const foreign = [{ ...corpus[0], id: 'foreign-site', scope: { workspaceId: 'primary-workspace', siteId: 'foreign-site' } }, { ...corpus[0], id: 'foreign-workspace', scope: { workspaceId: 'foreign', siteId: 'semantic-site' } }];
  const seedId = 'seed-' + Date.now();
  console.log('Seeded', await post('/seed', { records: [...corpus, ...foreign], reset_history: true, seed_id: seedId }));
  const recent = (await db.prepare("select id from learning_records where workspace_id='primary-workspace' and site_id='semantic-site' order by updated_at desc,id desc limit 20").all()).results;
  assert(!recent.some((r) => r.id === 'email-boundaries'), 'Old lesson must be outside the first directory page');
  report.older_than_first_page = true;
  await drain();
  for (const entry of relevanceCases) {
    const result = await post('/search', { query: entry.query, top_k: 5 });
    const ids = result.records.map((r) => r.id), rank = ids.indexOf(entry.expected) + 1;
    report.cases.push({ ...entry, rank, ids, scores: result.records.map((r) => r.similarity), coverage: result.coverage, status: result.status });
    assert(!ids.some((id) => id.startsWith('foreign')), 'Cross-scope recall');
    console.log('Recall case', entry.name, { rank, ids });
  }
  report.metrics = { total: report.cases.length, recall_at_1: report.cases.filter((r) => r.rank === 1).length / report.cases.length,
    recall_at_3: report.cases.filter((r) => r.rank > 0 && r.rank <= 3).length / report.cases.length,
    recall_at_5: report.cases.filter((r) => r.rank > 0).length / report.cases.length };
  await writeFile(resolve(root, 'retrieval-report.json'), JSON.stringify(report, null, 2));
  assert(report.metrics.recall_at_3 === 1, 'An expected relevant lesson was missing from the first 3 candidates');
  const beforeUtility = stats.upserts;
  await post('/revise', { id: 'pricing-transparency', operation_id: seedId + ':utility', utility: { score: 0.7, feedback_count: 2, calculation_version: 'ema-0.2-v1' } });
  await drain();
  assert.equal(stats.upserts, beforeUtility, 'Utility-only update must not re-index');
  const hydrated = await post('/search', { query: relevanceCases[5].query });
  assert.equal(hydrated.records.find((r) => r.id === 'pricing-transparency')?.utility.score, 0.7);
  report.utility_hydration = { score: 0.7, reindexed: false };
  await writeFile(resolve(root, 'retrieval-report.json'), JSON.stringify(report, null, 2));
  const nextInsight = 'Updated synthetic observation: for a manager requesting an impossible deadline, describe a feasible tradeoff in scope and timing; do not teach a blanket refusal. New source evidence supersedes the earlier wording.';
  await post('/revise', { id: 'email-boundaries', operation_id: seedId + ':content-revision', insight: nextInsight });
  const stale = await post('/search', { query: relevanceCases[0].query });
  assert(!stale.records.some((r) => r.id === 'email-boundaries'), 'A superseded embedding was presented as current');
  await drain();
  const refreshed = await post('/search', { query: relevanceCases[0].query });
  assert.equal(refreshed.records.find((r) => r.id === 'email-boundaries')?.experience.insight, nextInsight);
  report.content_revision = { stale_filtered: true, new_content_recalled: true };
  await writeFile(resolve(root, 'retrieval-report.json'), JSON.stringify(report, null, 2));
  } else {
    report = JSON.parse(await readFile(resolve(root, 'retrieval-report.json'), 'utf8'));
  }
  if (process.env.VERIFY_LEADER === '1') {
    const runId = 'semantic-leader-' + Date.now();
    await post('/start', { id: runId, title: 'Plan a workplace email content experiment', text: 'Plan our next workplace-email article experiment for employees whose manager demands an impossible delivery date. Use our saved business experience where it genuinely changes your decision, including lessons from unsuccessful pilots. The supplied pilot target is 10 clicks in the first 7 publication days; we know GSC may be unavailable locally. Preserve unknowns. Prepare and record the practice and any actual adopted lessons. Give one concrete proposed topic and explain the business judgment. Do not delegate, write or publish an article yet; this request is for the experimental plan only.' });
    let evidence;
    for (let i = 0; i < 100; i++) {
      await post('/recover');
      evidence = await (await runtime.dispatchFetch('http://localhost/evidence')).json();
      const task = evidence.tasks.find((t) => t.id === runId);
      console.log('Leader verification', i, task?.status, evidence.tools.filter((t) => t.task_id === runId).map((t) => t.action.name));
      if (task && ['waiting', 'completed', 'failed', 'paused'].includes(task.status)) break;
      await pause(6000);
    }
    report.leader = evidence;
    await writeFile(resolve(root, 'leader-evidence.json'), JSON.stringify(evidence, null, 2));
    assert(evidence.tools.some((t) => t.task_id === runId && t.action.name === 'find_business_experience'), 'Leader did not actually use semantic recall');
    assert(evidence.uses.some((u) => u.task_id === runId && u.experience_id === 'email-boundaries'), 'Leader did not save adoption of the relevant lesson');
    assert(!evidence.uses.some((u) => u.task_id === runId && u.experience_id === 'email-keyword-bait'), 'Leader adopted the high-utility keyword distractor');
    report.leader_verified = true;
    const rejectionId = 'semantic-no-fit-' + Date.now();
    await post('/start', { id: rejectionId, title: 'Check applicability of history to an unrelated question', text: 'Check whether any saved business experience provides evidence for explaining why the Moon is tidally locked to Earth. Search our experience history and report whether an applicable lesson exists. If the returned records concern other subjects, say they do not answer this question. Do not create a practice, adopt unrelated lessons, delegate work, or publish anything. This is an applicability check, not a content experiment.' });
    let rejected;
    for (let i = 0; i < 60; i++) {
      await post('/recover');
      rejected = await (await runtime.dispatchFetch('http://localhost/evidence')).json();
      const task = rejected.tasks.find((t) => t.id === rejectionId);
      console.log('Unrelated intent verification', i, task?.status);
      if (task && ['waiting', 'completed', 'failed', 'paused'].includes(task.status)) break;
      await pause(6000);
    }
    assert(rejected.tools.some((t) => t.task_id === rejectionId && t.action.name === 'find_business_experience' && t.result.status === 'ok' && t.result.records.length > 0), 'Unrelated intent must actually inspect semantic neighbors');
    assert(!rejected.uses.some((u) => u.task_id === rejectionId), 'Unrelated semantic neighbors must not become adopted experience');
    assert(['waiting','completed'].includes(rejected.tasks.find((t) => t.id === rejectionId)?.status), 'Applicability check did not finish');
    report.rejected_unrelated_intent = { run_id: rejectionId, no_adoption: true };
    await writeFile(resolve(root, 'leader-rejection-evidence.json'), JSON.stringify(rejected, null, 2));
  }
  if (process.env.VERIFY_LEADER === '1' || process.env.VERIFY_INDEX_ONLY === '1') {
    await drain();
    const generated = (await db.prepare("select id from learning_records where origin_task_id like 'semantic-leader-%'").all()).results.map((r) => r.id);
    assert(generated.length > 0, 'No real Learning Agent record exists');
    const recall = await post('/search', { query: 'What was the prepared plan for a future workplace article helping employees respond to an unrealistic manager deadline, and why was its seven-day click result still unknown?', top_k: 5 });
    const hits = recall.records.filter((r) => generated.includes(r.id));
    assert(hits.length > 0, 'Newly model-generated learning was not recalled after indexing');
    report.generated_practice_recall = { ids: hits.map((r) => r.id), coverage: recall.coverage, results: recall.records };
  }
  report.stats = stats;
  report.completed_at = new Date().toISOString();
  await writeFile(resolve(root, 'retrieval-report.json'), JSON.stringify(report, null, 2));
  console.log('Verified', JSON.stringify({ metrics: report.metrics, stats, leader_verified: report.leader_verified || false }));
} catch (error) {
  verificationError = error;
  throw error;
} finally {
  await writeFile(resolve(root, 'last-stats.json'), JSON.stringify(stats, null, 2));
  await runtime?.dispose();
  if (process.env.KEEP_LEARNING_INDEX !== '1') {
    try {
      const response = await fetch(base + '/vectorize/v2/indexes/' + name, { method: 'DELETE', headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(30000) });
      const result = await response.json();
      if (!result.success && ![404, 410].includes(response.status)) throw new Error('Index deletion was not confirmed');
      await writeFile(resolve(root, 'index.json'), JSON.stringify({ ...index, deleted: true }, null, 2));
      console.log('Removed isolated acceptance index', name);
    } catch {
      const cleanupError = new Error('Cleanup not confirmed for isolated index ' + name + '; check it with Wrangler and delete it if still present. The saved index receipt is retained.');
      if (!verificationError) throw cleanupError;
      console.error(cleanupError.message);
    }
  }
}
