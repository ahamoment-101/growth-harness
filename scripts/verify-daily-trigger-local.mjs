// Disposable Miniflare Worker/D1/Workflow check. The model is deterministic and outbound calls are blocked.
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const source = `
  export { AgentRuntimeWorkflow } from './worker/agent-runtime/durable-workflow';
  export { AgentShell } from './worker/agent-runtime/shell';
  export { SiteRoom } from './worker/site-room/room';
  import worker from './worker/index';
  import { runtimeAgentModule } from './worker/agent-runtime/agent-modules';
  import { runLeaderConversation } from './worker/growth-leader/runtime';
  import { replayConversationResponse } from './worker/agent-runtime/conversation-replay';
  import { stopTask } from './worker/agent-runtime/task-store';
  import { createSession, sessionCookie } from './worker/lib/auth/session';
  const model={id:'fixture',name:'fixture',api:'openai-completions',provider:'fixture',baseUrl:'https://fixture.invalid',reasoning:false,input:['text'],contextWindow:32000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  let decision=0;
  const stream=(m,c,o)=>{
    const results=c.messages.filter(message=>message.role==='toolResult');
    const discovered=results.find(message=>message.toolName==='discover_agents');
    const delegated=results.find(message=>message.toolName==='delegate_task');
    let call;
    if(!discovered) call={id:'discover-'+(++decision),name:'discover_agents',arguments:{}};
    else if(!delegated) {
      const data=JSON.parse(discovered.content[0].text);
      const scope=data.scopes.find(item=>item.locale==='en');
      if(!scope) throw new Error('The English site scope is unavailable');
      call={id:'delegate-'+(++decision),name:'delegate_task',arguments:{agent_ref:'topic_decision',scope_ref:scope.scope_ref,
        goal:'Kick off a new batch of topics',reason:'The scheduled daily topic trigger saved on the site has reached its time',context:'Based on the existing keyword library and in-flight topics, deliver a topic set ready for review.'}};
    }
    const reply={role:'assistant',content:call?[{type:'toolCall',...call}]:[{type:'text',text:'Handed today's topics to the Topic Editor.'}],
      api:model.api,provider:model.provider,model:model.id,stopReason:call?'toolUse':'stop',timestamp:Date.now(),
      usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    return replayConversationResponse(reply,stream)(m,c,o);
  };
  runtimeAgentModule('growth_leader').execute=({env,step,run})=>runLeaderConversation({env,step,runId:run.id,transport:{model,stream}});
  runtimeAgentModule('topic_decision').execute=async({env,run})=>{
    await stopTask(env.DB,run.id,'waiting','Synthetic fixture stopped before topic generation','deferred');
    return {output:{},phase:'waiting'};
  };
  export default {
    fetch: async(request,env,ctx)=>{
      const url=new URL(request.url);
      if(url.pathname==='/__fixture/login') {
        const user=await env.DB.prepare("select * from app_users where id='fixture-user'").first();
        const workspace=await env.DB.prepare("select * from workspaces where id='primary-workspace'").first();
        const token=await createSession(env.DB,{user,workspace});
        return new Response(null,{status:302,headers:{Location:'/website/s','Set-Cookie':sessionCookie(url,token)}});
      }
      if(url.pathname==='/__fixture/cron') {
        await worker.scheduled({cron:'* * * * *',scheduledTime:Date.parse('2026-09-26T01:00:00.000Z')},env,ctx);
        return Response.json({ok:true});
      }
      url.host='127.0.0.1:5298';
      url.protocol='http:';
      const localRequest=new Request(url,request);
      if(localRequest.headers.get('Origin')==='http://127.0.0.1') localRequest.headers.set('Origin',url.origin);
      return worker.fetch(localRequest,env,ctx);
    }
  };
`;
const bundled = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'daily-trigger-verifier.ts', contents: source },
  bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'],
  plugins: [{ name: 'node-path-interop', setup(builder) {
    builder.onResolve({ filter: /^path$/ }, () => ({ path: 'path', namespace: 'builtin-shim' }));
    builder.onLoad({ filter: /.*/, namespace: 'builtin-shim' }, () => ({ contents: "export * from 'node:path';", loader: 'js' }));
  } }] });
const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-08-18',
  compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  workflows: { AGENT_WORKFLOW: { name: 'daily-trigger-fixture', className: 'AgentRuntimeWorkflow' } },
  durableObjects: { AGENT_SHELL: { className: 'AgentShell', useSQLite: true }, SITE_ROOM: { className: 'SiteRoom', useSQLite: true } },
  bindings: { APP_AUTH_MODE: 'required', AGENT_RUNTIME_ENABLED: 'true' },
  outboundService: async () => new Response('External requests disabled in daily trigger fixture', { status: 503 }),
}));

try {
  const db = await runtime.getD1Database('DB');
  const migrationDir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrationDir)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec((await readFile(new URL(file, migrationDir), 'utf8'))
      .replace(/'(?:''|[^'])*'|--[^\n]*/g, part => part.startsWith('--') ? '' : part).replace(/\n/g, ' '));
  }
  await db.prepare("insert into sites(id,name,ingest_url,source_locale,translate_locales_json) values('s','Sandbox site','https://example.invalid','en','[]')").run();
  await db.prepare("insert into app_users(id,google_sub,email,display_name,created_at,last_login_at) values('fixture-user','synthetic','fixture@example.invalid','Local verifier',datetime('now'),datetime('now'))").run();
  await db.prepare("update workspaces set owner_user_id='fixture-user' where id='primary-workspace'").run();
  const login=await runtime.dispatchFetch('http://127.0.0.1:5298/__fixture/login',{redirect:'manual'});
  const cookie=login.headers.get('set-cookie')?.split(';')[0];
  if(!cookie) throw new Error('Fixture login did not issue a session');
  const saved=await runtime.dispatchFetch('http://127.0.0.1:5298/api/sites/s/daily-trigger',{
    method:'PUT',headers:{Cookie:cookie,Origin:'http://127.0.0.1:5298','Content-Type':'application/json'},
    body:JSON.stringify({enabled:true,task_mode:'scheduled',action:'start_topic_batch',local_time:'09:00'})});
  if(!saved.ok) throw new Error(`Config save failed: ${saved.status} ${await saved.text()}`);
  const config=(await saved.json()).trigger;
  if(config?.action!=='start_topic_batch'||config?.timezone!=='Asia/Shanghai'||config?.local_time!=='09:00') throw new Error('Config read-back mismatch');
  await db.prepare("update daily_triggers set next_due_at='2026-09-26T01:00:00.000Z' where site_id='s'").run();
  const response = await runtime.dispatchFetch('http://localhost/__fixture/cron');
  if (!response.ok) throw new Error(`Scheduled event failed: ${response.status}`);
  const runId = 'daily-topics:s:2026-09-26';
  let child;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    child = await db.prepare("select id,agent_id,parent_task_id,status,assignment_id from agent_tasks where agent_id='topic_decision' and parent_task_id=?")
      .bind(runId).first();
    if (child) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const conversation = await db.prepare('select id,title from leader_conversations where id=?').bind(runId).first();
  const run = await db.prepare('select trigger,schedule_key from agent_runs where id=?').bind(runId).first();
  const input = await db.prepare('select id,kind,content,read_at from leader_inputs where conversation_id=?').bind(runId).first();
  const assignment = child && await db.prepare('select context_json from agent_task_assignments where id=?').bind(child.assignment_id).first();
  const fires = await db.prepare('select site_id,local_date,delivered_at from daily_trigger_fires').all();
  await runtime.dispatchFetch('http://localhost/__fixture/cron');
  const repeatFireCount = await db.prepare('select count(*) as n from daily_trigger_fires').first();
  const repeatChildCount = await db.prepare("select count(*) as n from agent_tasks where agent_id='topic_decision' and parent_task_id=?").bind(runId).first();
  if (!conversation || run?.trigger !== 'cron' || !input?.content.includes('Kick off a batch of topics') ||
      child?.agent_id !== 'topic_decision' || !assignment?.context_json || fires.results.length !== 1 ||
      repeatFireCount?.n !== 1 || repeatChildCount?.n !== 1) {
    throw new Error(JSON.stringify({ conversation, run, input: input && { id: input.id, read_at: input.read_at }, child, assignment,
      fires: fires.results, repeatFireCount, repeatChildCount }));
  }
  console.log(JSON.stringify({ verified: 'authenticated config API, real Worker scheduled handler, isolated D1, Leader conversation and topic delegation',
    config: { enabled: config.enabled, task_mode: config.task_mode, action: config.action, local_time: config.local_time, timezone: config.timezone },
    conversation, run, input: { id: input.id, kind: input.kind, read_at: input.read_at },
    child: { id: child.id, agent_id: child.agent_id, parent_task_id: child.parent_task_id, status: child.status },
    assignment: JSON.parse(assignment.context_json), fires: fires.results, repeatFireCount: repeatFireCount.n, repeatChildCount: repeatChildCount.n,
    model: 'synthetic fixture; no provider or external business calls' }));
} finally { await runtime.dispose(); }
