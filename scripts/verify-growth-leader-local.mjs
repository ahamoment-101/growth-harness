// Isolated real Worker + D1 + UI fixture. No model or provider calls.
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const selfHosting = process.env.SELF_HOSTING_VERIFY === '1';
const port = Number(process.env.SELF_HOSTING_PORT || (selfHosting ? 5296 : 5297));
const bundled = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'research-workflow-verifier.ts', contents: `
  export { AgentRuntimeWorkflow } from './worker/agent-runtime/durable-workflow';
  export { AgentShell } from './worker/agent-runtime/shell';
  export { SiteRoom } from './worker/site-room/room';
  import worker from './worker/index';
  import { runtimeAgentModule } from './worker/agent-runtime/agent-modules';
  import { runLeaderConversation } from './worker/growth-leader/runtime';
  import { replayConversationResponse } from './worker/agent-runtime/conversation-replay';
  import { stopTask } from './worker/agent-runtime/task-store';
  const model={id:'fixture',name:'fixture',api:'openai-completions',provider:'fixture',baseUrl:'https://fixture.invalid',reasoning:false,input:['text'],contextWindow:32000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  let reportRef='';
  const stream=(m,c,o)=>{
    // Preparation observations may follow any tool receipt. Select receipts from native history, not the final message.
    const results=c.messages.filter(message=>message.role==='toolResult');
    const result=name=>results.findLast(message=>message.toolName===name);
    const decoded=name=>JSON.parse(result(name).content[0].text);
    const hasReport=c.messages.some(message=>message.role==='user'&&JSON.stringify(message.content).includes('agent.task_report_ready'));
    let text='Delegated to the Deep Researcher; the results will come back to this conversation.';
    let calls=[];
    const invoke=(name,args)=>{calls=[{id:name+'-'+crypto.randomUUID(),name,arguments:args}];};
    for (const receipt of results) if(receipt.isError) throw new Error('Synthetic verifier received a tool failure: '+JSON.stringify(receipt.content));
    if(result('delegate_task') && decoded('delegate_task').learning_practice_ref !== null) throw new Error('Coordination-only fixture unexpectedly linked a learning practice');
    if(hasReport) {
      if(!result('read_my_inbox')) invoke('read_my_inbox',{});
      else {
        const report=decoded('read_my_inbox').events.find(event=>event.type==='agent.task_report_ready');
        if(!report) throw new Error('Task report missing from subscribed inbox');
        reportRef=report.event_id;
        if(!result('read_task')) invoke('read_task',{task_ref:report.subject_id});
        else if(!result('complete_inbox_event')) invoke('complete_inbox_event',{event_ref:reportRef,reason:'Read the research results and decided the next step'});
        else text='The team research has returned: enterprise customers care about procurement rationale. Next, we can discuss how to explain the value on the product page.';
      }
    } else if(!result('read_workspace')) invoke('read_workspace',{section:'overview'});
    else if(!result('discover_agents')) invoke('discover_agents',{});
    // This fixture verifies child coordination, without preparing or evaluating a learning practice.
    else if(!result('delegate_task')) invoke('delegate_task',{agent_ref:'deep_research',scope_ref:decoded('discover_agents').scopes[0].scope_ref,goal:'Research enterprise customer needs',reason:'Support product positioning',context:'',practice_ref:null,experience_uses:[]});
    const reply={role:'assistant',content:calls.length?calls.map(c=>({type:'toolCall',...c})):[{type:'text',text}],api:model.api,provider:model.provider,model:model.id,stopReason:calls.length?'toolUse':'stop',timestamp:Date.now(),usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    return replayConversationResponse(reply,stream)(m,c,o);
  };
  // Deterministic model/provider fixture; real Pi loop, Workflow, D1 and child start remain in use.
  runtimeAgentModule('growth_leader').execute=({env,step,run})=>runLeaderConversation({env,step,runId:run.id,transport:{model,stream}});
  runtimeAgentModule('deep_research').execute=async({env,run})=>{
    await stopTask(env.DB,run.id,'completed','Local synthetic research results','completed',{summary:'Enterprise customers care about procurement rationale',sources:[],fixture:true});
    return {output:{},phase:'completed'};
  };

  import { createSession, sessionCookie } from './worker/lib/auth/session';
  export default { async fetch(request,env,ctx) {
    if(!${selfHosting} && new URL(request.url).pathname==='/__fixture/login') {
      const user=await env.DB.prepare("select * from app_users where id='fixture-user'").first();
      const workspace=await env.DB.prepare("select * from workspaces where id='primary-workspace'").first();
      const token=await createSession(env.DB,{user,workspace});
      return new Response(null,{status:302,headers:{Location:'/website/s','Set-Cookie':sessionCookie(new URL(request.url),token)}});
    }
    // Miniflare's proxy rewrites the URL host; restore the known local public origin for CSRF checks.
    const localUrl = new URL(request.url);
    localUrl.host = '127.0.0.1:${port}';
    localUrl.protocol = 'http:';
    const localRequest = new Request(localUrl, request);
    // The local Miniflare proxy strips the nonstandard port from Origin.
    if (localRequest.headers.get('Origin') === 'http://127.0.0.1') localRequest.headers.set('Origin', localUrl.origin);
    return worker.fetch(localRequest,env,ctx);
  } };
` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'], plugins: [{ name: 'node-path-interop', setup(builder) { builder.onResolve({filter: /^path$/}, () => ({path: 'path', namespace: 'builtin-shim'})); builder.onLoad({filter: /.*/, namespace: 'builtin-shim'}, () => ({contents: "export * from 'node:path';", loader: 'js'})); } }] });

const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port, modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: '2026-08-18', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  workflows: { AGENT_WORKFLOW: { name: 'local-panel', className: 'AgentRuntimeWorkflow' } },
  durableObjects: { AGENT_SHELL: { className: 'AgentShell', useSQLite: true }, SITE_ROOM: { className: 'SiteRoom', useSQLite: true } },
  bindings: { OPENROUTER_API_KEY: 'synthetic-fixture-key-not-a-real-credential', AUTH_LOGIN_METHODS: 'password', AUTH_SETUP_TOKEN: 'isolated-fixture-initialization-token', AGENT_RUNTIME_ENABLED: 'true' },
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
  await db.prepare("insert into sites(id,name,ingest_url,source_locale,translate_locales_json) values('s','Growth Leader · Local Acceptance','https://fixture.invalid','en','[]')").run();
  if (selfHosting && process.env.SELF_HOSTING_BROWSER_SETUP === '1') {
    console.log('Browser setup ready: http://127.0.0.1:'+port+'/login; isolated D1, synthetic model, no provider calls');
    await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
    process.exitCode = 0;
  } else {
  let cookie;
  const base = `http://127.0.0.1:${port}`;
  const authCall = (path, body, token = cookie) => runtime.dispatchFetch(base + path, {method: body ? 'POST' : 'GET', headers: {Origin: base, 'Content-Type':'application/json', ...(token ? {Cookie:token} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  if (selfHosting) {
    const state = await (await authCall('/api/auth/me')).json();
    if (!state.setup_required || state.methods.join() !== 'password') throw new Error('Expected protected first-owner setup');
    const unauthenticated = await authCall('/api/sites');
    if (unauthenticated.status !== 401) throw new Error('Site management was accessible before login');
    // Competing initializations exercise the real atomic D1 transaction, not a mocked batch.
    const input = {email:'owner@example.invalid',password:'isolated-password-original',setup_token:'isolated-fixture-initialization-token'};
    const racing = await Promise.all([authCall('/api/auth/setup', input), authCall('/api/auth/setup', {...input,email:'other@example.invalid'})]);
    if (racing.filter(r => r.status===200).length !== 1 || racing.filter(r => r.status===409).length !== 1) throw new Error('First-owner claim was not atomic: '+racing.map(r=>r.status));
    const successful = racing.find(r=>r.status===200);
    cookie = successful.headers.get('set-cookie').split(';')[0];
    const owner = await (await authCall('/api/auth/me')).json();
    const before = cookie;
    const changed = await authCall('/api/auth/password',{current_password:input.password,password:'isolated-password-browser'});
    if(changed.status!==200) throw new Error('Password change failed: '+await changed.text());
    cookie=changed.headers.get('set-cookie').split(';')[0];
    if((await (await authCall('/api/auth/me',undefined,before)).json()).authenticated) throw new Error('Old session survived password change');
    const login=await authCall('/api/auth/password/login',{email:owner.user.email,password:'isolated-password-browser'});
    if(login.status!==200) throw new Error('Real password login failed: '+await login.text());
    cookie=login.headers.get('set-cookie').split(';')[0];
    console.log(JSON.stringify({verified:'real password setup, concurrent owner fencing, login and session revocation',email:owner.user.email,model:'synthetic; no provider calls'}));
    const created=await runtime.dispatchFetch(base+'/api/sites',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({domain:'example.invalid',name:'Self-hosting browser acceptance'})});
    if(created.status!==201) throw new Error('Authenticated site creation failed: '+await created.text());
  } else {
    await db.prepare("insert into app_users(id,google_sub,email,display_name,created_at,last_login_at) values('fixture-user','synthetic','fixture@example.invalid','Local verifier',datetime('now'),datetime('now'))").run();
    await db.prepare("update workspaces set owner_user_id='fixture-user' where id='primary-workspace'").run();
    const login=await runtime.dispatchFetch(base+'/__fixture/login',{redirect:'manual'});
    cookie=login.headers.get('set-cookie').split(';')[0];
  }
  const call=async(path,body)=>{
    const response=await runtime.dispatchFetch(base+'/api/sites/s/leader/'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();
    if(!response.ok) throw new Error(JSON.stringify({status:response.status,value}));
    return value;
  };
  const id=crypto.randomUUID();
  const first = { id, title: 'Enterprise customer growth', message: { id: crypto.randomUUID(), text: 'Help me research enterprise customer needs' } };
  if ((await call('configuration')).state !== 'configured') throw new Error('Configured model was not detected');
  await call('start', first);
  await call('start', first); // Lost-response replay must keep one conversation and one input.
  let detail;
  const until=Date.now()+90000;
  while(Date.now()<until) {
    detail=await call('conversations/'+id);
    if(detail.messages.some(m=>m.role==='assistant' && m.text.includes('team research has returned'))) break;
    if(['failed','paused'].includes(detail.conversation.status)) throw new Error(JSON.stringify(detail));
    await new Promise(r=>setTimeout(r,500));
  }
  if(!detail.messages.some(m=>m.role==='assistant'&&m.text.includes('team research has returned'))) throw new Error('Report did not resume original conversation: '+JSON.stringify(detail));
  if((await call('conversations')).conversations.length!==1) throw new Error('Report created a new conversation');
  const reports=await db.prepare("select d.status from agent_event_deliveries d join agent_pool_events e on e.id=d.event_id where e.type='agent.task_report_ready' and d.target_run_id=?").bind(id).all();
  if(reports.results.length!==1 || reports.results[0].status!=='completed') throw new Error('Task report delivery was not completed: '+JSON.stringify(reports.results));
  console.log(JSON.stringify({verified:'real Workflow and D1, native Pi, original-conversation child report and acknowledgement',conversation:id,messages:detail.messages.length,tasks:detail.tasks.length,login:base+(selfHosting?'/login':'/__fixture/login'),model:'synthetic fixture; no provider calls'}));
  if(process.env.LEADER_UI==='1') await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  }
} finally { await runtime.dispose(); }
