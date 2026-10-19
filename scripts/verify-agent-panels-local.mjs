// Isolated real Worker + D1 + UI fixture. No model or provider calls.
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const bundled = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'research-workflow-verifier.ts', contents: `
  export { AgentRuntimeWorkflow } from './worker/agent-runtime/durable-workflow';
  export { AgentShell } from './worker/agent-runtime/shell';
  import worker from './worker/index';
  import { createSession, sessionCookie } from './worker/lib/auth/session';
  export default { async fetch(request,env,ctx) {
    if(new URL(request.url).pathname==='/__fixture/login') {
      const user=await env.DB.prepare("select * from app_users where id='fixture-user'").first();
      const workspace=await env.DB.prepare("select * from workspaces where id='primary-workspace'").first();
      const token=await createSession(env.DB,{user,workspace});
      return new Response(null,{status:302,headers:{Location:'/website/s','Set-Cookie':sessionCookie(new URL(request.url),token)}});
    }
    // Miniflare's proxy rewrites the URL host; restore the known local public origin for CSRF checks.
    const localUrl = new URL(request.url);
    localUrl.host = '127.0.0.1:5198';
    localUrl.protocol = 'http:';
    const localRequest = new Request(localUrl, request);
    // The local Miniflare proxy strips the nonstandard port from Origin.
    if (localRequest.headers.get('Origin') === 'http://127.0.0.1') localRequest.headers.set('Origin', localUrl.origin);
    return worker.fetch(localRequest,env,ctx);
  } };
` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'], plugins: [{ name: 'node-path-interop', setup(builder) { builder.onResolve({filter: /^path$/}, () => ({path: 'path', namespace: 'builtin-shim'})); builder.onLoad({filter: /.*/, namespace: 'builtin-shim'}, () => ({contents: "export * from 'node:path';", loader: 'js'})); } }] });

const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: 5198, modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: '2026-08-18', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  workflows: { AGENT_WORKFLOW: { name: 'local-panel', className: 'AgentRuntimeWorkflow' } },
  durableObjects: { AGENT_SHELL: { className: 'AgentShell', useSQLite: true } },
  bindings: { APP_AUTH_MODE: 'required', AGENT_RUNTIME_ENABLED: 'true' },
  outboundService: async () => new Response('External calls disabled in UI fixture', { status: 503 }),
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
  for (const file of (await readdir(migrationDir)).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec((await readFile(new URL(file, migrationDir), 'utf8')).replace(/'(?:''|[^'])*'|--[^\n]*/g, part => part.startsWith('--') ? '' : part).replace(/\n/g, ' '));
  }
  await db.prepare("insert into sites(id,name,ingest_url,source_locale,translate_locales_json) values('s','Agent Panels · Local Acceptance','https://fixture.invalid','en','[]')").run();
  await db.prepare("insert into app_users(id,google_sub,email,display_name,created_at,last_login_at) values('fixture-user','synthetic','fixture@example.invalid','Local verifier',datetime('now'),datetime('now'))").run();
  await db.prepare("update workspaces set owner_user_id='fixture-user' where id='primary-workspace'").run();
  for (const [id, agent, status, reason, updated] of [
    ['topic-review', 'topic_decision', 'completed', 'Topic proposal submitted, awaiting your decision.', '2026-09-20T08:00:00Z'],
    ['topic-reject', 'topic_decision', 'completed', 'Another proposal is awaiting your decision.', '2026-09-20T08:05:00Z'],
    ['strategy-done', 'strategy_research', 'completed', 'This round\'s strategy research has been delivered; see the file for details.', '2026-09-20T05:20:00Z'],
    ['strategy-active', 'strategy_research', 'running', 'Researching the English learning market and organizing verifiable content directions.', '2026-09-20T07:20:00Z'],
    ['editor-waiting', 'content_production', 'waiting', 'Please provide the target market for this round\'s articles.', '2026-09-20T06:00:00Z'],
    ['editor-done', 'content_production', 'completed', 'This round\'s content plan is complete; the market remains a pending confirmation item.', '2026-09-20T07:00:00Z'],
    ['writer-active', 'article_production', 'running', 'Article draft saved, currently checking citations.', '2026-09-20T07:25:00Z'],
  ]) {
    await db.prepare(`insert into agent_runs(id,workspace_id,site_id,agent_id,agent_instance_id,definition_version,prompt_version,trigger,status,phase,root_run_id,summary_json,created_at,updated_at)
      values(?,'primary-workspace','s',?, ?,1,'fixture','manual',?,'working',?,'{}',?,?)`)
      .bind(id, agent, id === 'writer-active' ? 'English Learning Method Guide' : id === 'strategy-active' ? 'English Market · Content Strategy' : 'This round\'s content plan', status === 'completed' ? 'succeeded' : status === 'waiting' ? 'waiting_for_input' : 'running', id, updated, updated).run();
    await db.prepare(`insert into agent_tasks(id,workspace_id,site_id,agent_id,agent_instance_id,definition_version,recovery_policy_version,status,active_run_id,goal_json,max_turns,max_model_calls,max_tokens,created_at,updated_at,root_task_id,reason,outcome)
      values(?,'primary-workspace','s',?, ?,1,1,?,?,?,0,0,0,?,?,?, ?,?)`)
      .bind(id, agent, id === 'writer-active' ? 'English Learning Method Guide' : id === 'strategy-active' ? 'English Market · Content Strategy' : 'This round\'s content plan', status, id, JSON.stringify({ goal: 'Help readers find an English learning method that suits them', locale: 'en', market: 'United States' }), updated, updated, id, reason, status === 'completed' ? 'completed' : status === 'waiting' ? 'deferred' : '').run();
    await db.prepare("insert into agent_task_runs(task_id,run_id,epoch) values(?,?,1)").bind(id,id).run();
    if (status === 'running') await db.prepare(`insert into agent_task_operations(id,task_id,turn,status,context_json,action_json,created_at,updated_at) values(?,?,1,'running','{}',?,?,?)`)
      .bind(id + ':1', id, JSON.stringify({name: agent === 'article_production' ? 'run_self_check' : 'search_web'}), updated, updated).run();
  }
  await db.prepare('update agent_tasks set workspace_json=? where id=?').bind(JSON.stringify({blueprint: { executive_strategy: 'Prioritize answering learners\' real questions, and support every recommendation with reliable sources.', roadmap: 'Complete the target market research first, then filter content directions that fit the product\'s capabilities.' }, keywords: []}), 'strategy-active').run();
  await db.prepare('update agent_tasks set output_json=? where id=?').bind(JSON.stringify({summary: 'Completed this round\'s content plan', recommended_action: 'Continue to the next round after confirming the target market', evidence: ['Existing business materials have been verified']}), 'editor-done').run();
  await db.prepare("insert into agent_parameter_slots(task_id,ref,kind,value_json) values('writer-active','fixture-draft','article_draft',?)")
    .bind(JSON.stringify({ assignment_id: '', bundle: { versions: [{ locale: 'en', title: 'Build a Reading Habit That Lasts', content: '# Build a Reading Habit That Lasts\n\nStart with a short text that interests you. A small, repeatable reading session is easier to maintain than an ambitious plan.\n\n## Choose a manageable passage\n\nRead one paragraph, note unfamiliar phrases, and return to the original context.\n\n## Review what you learned\n\nUse your notes to explain the passage in your own words.' }] }, editorial: { notes: 'Local acceptance draft; not online content.' } })).run();
  await db.prepare("insert into seo_strategy_versions(id,site_id,run_id,submission_operation_id,version,locale_version,status,source_locale) values('fixture-strategy','s','strategy-done','fixture-submit',1,1,'active','en')").run();
  for (const [id, kind, body] of [['fixture-strategy-doc','strategy','# Delivered Strategy\n\nThis file should match the file cabinet display exactly.'], ['fixture-research-doc','research_notes','# Research Basis\n\nThis is the second file for the same Task.']]) {
    await db.prepare('insert into seo_strategy_documents(id,strategy_version_id,doc_type,body_md) values(?,?,?,?)').bind(id,'fixture-strategy',kind,body).run();
  }
  await db.prepare("update agent_tasks set output_json=? where id='strategy-done'").bind(JSON.stringify({summary:'Two research files delivered',reason:'This round\'s research is complete'})).run();
  for (const runId of ['topic-review', 'topic-reject']) {
    await db.prepare(`insert into topic_decision_results(id,workspace_id,site_id,run_id,submission_operation_id,strategy_version_id,strategy_version,decision_type,status,group_goal,rationale,requested_count,scope_locale,created_at,updated_at)
      values(?,'primary-workspace','s',?,?,null,0,'topic_group','draft','Help readers build a sustainable reading habit',?,1,'en','2026-09-20T08:10:00Z','2026-09-20T08:10:00Z')`)
      .bind(runId + '-group', runId, runId + '-submit', 'Start from real reader problems and validate short-form reading and review methods.').run();
    await db.prepare(`insert into topic_decision_items(id,result_id,strategy_keyword_id,keyword_id,topic_key,title_direction,primary_keyword,content_type,locale,search_intent,group_role,rationale,hypothesis,sort_order,created_at)
      values(?,?,'fixture','fixture','reading-habit','How to build a sustainable English reading habit','reading habit','GUIDE','en','Learning reading methods','Answering beginner questions','Help readers choose repeatable small exercises','Lower the barrier to starting to read',0,'2026-09-20T08:10:00Z')`)
      .bind(runId + '-item', runId + '-group').run();
    await db.prepare('insert into agent_work_notes(task_id,sequence,body,created_at) values(?,1,?,?)')
      .bind(runId, 'I have reviewed the current strategy and existing articles. This proposal centers on reading habits; its actual effectiveness still needs to be validated by subsequent content performance.', '2026-09-20T08:06:00Z').run();
  }
  console.log('Isolated panel fixture: ' + new URL('/__fixture/login', await runtime.ready));
  await new Promise(resolve => { const timer = setTimeout(resolve, 900000); process.once('SIGINT', () => { clearTimeout(timer); resolve(); }); });
} finally { await runtime.dispose(); }
