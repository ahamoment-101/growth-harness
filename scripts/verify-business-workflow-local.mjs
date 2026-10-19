import { fixtureModelRegistry } from './runtime-fixture-capabilities.mjs';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Real business dispatch, native conversation, Workflow, D1 and R2. Synthetic model and page.
const bundled = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'research-workflow-verifier.ts', contents: `
  export { AgentRuntimeWorkflow } from './worker/agent-runtime/durable-workflow';
  export { AgentShell } from './worker/agent-runtime/shell';
  import worker from './worker/index';
  import { createSession, sessionCookie, authenticateRequest } from './worker/lib/auth/session';
  import { startRuntimeRun } from './worker/agent-runtime/run-service';
  import { createAgentRun } from './worker/agent-runtime/store';
  import { agentDefinition } from './worker/agent-runtime/definitions';
  import { attachTask } from './worker/agent-runtime/task-store';
  import { createRuntimeExecution, activateRuntimeExecution, authorityForExecution } from './worker/agent-runtime/runtime-executions';
  import { executionEnvironment } from './worker/agent-runtime/execution-context';
  export default { async fetch(request,env,ctx) {
    if(new URL(request.url).pathname==='/__fixture/login') {
      const user=await env.DB.prepare("select * from app_users where id='fixture-user'").first();
      const workspace=await env.DB.prepare("select * from workspaces where id='primary-workspace'").first();
      const token=await createSession(env.DB,{user,workspace});
      return new Response(null,{status:302,headers:{Location:'/website/s/business','Set-Cookie':sessionCookie(new URL(request.url),token)}});
    }
    if(new URL(request.url).pathname==='/__fixture/start-business' && request.method==='POST') {
      const principal=await authenticateRequest(env.DB,request);
      if(!principal) return Response.json({error:'authentication required'},{status:401});
      const definition=agentDefinition('strategy_research');
      const parent=await createAgentRun(env.DB,{id:'fixture-parent',workspaceId:principal.workspace.id,siteId:'s',agentId:definition.id,
        definitionVersion:definition.definitionVersion,promptVersion:definition.promptVersion,trigger:'manual',summary:{fixture:true}});
      await attachTask(env.DB,parent,definition);
      const execution=await createRuntimeExecution(env.DB,parent.id);
      const authority=authorityForExecution(execution);
      await activateRuntimeExecution(env.DB,authority,execution.workflow_id);
      const run=await startRuntimeRun(executionEnvironment(env,authority),{workspaceId:principal.workspace.id,siteId:'s',agentId:'business_research',trigger:'sub_agent',parentRunId:parent.id});
      return Response.json({run},{status:202});
    }
    return worker.fetch(request,env,ctx);
  } };
` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'], plugins: [{ name: 'node-path-interop', setup(builder) { builder.onResolve({filter: /^path$/}, () => ({path: 'path', namespace: 'builtin-shim'})); builder.onLoad({filter: /.*/, namespace: 'builtin-shim'}, () => ({contents: "export * from 'node:path';", loader: 'js'})); } }] });

let requests=0; let fixtureDb;
const runtime=new Miniflare(convertV4MiniflareOptions({
  host:'127.0.0.1',port:5200,modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-08-18',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['RESEARCH_BUCKET'],
  workflows:{AGENT_WORKFLOW:{name:'local-strategy',className:'AgentRuntimeWorkflow'}},
  durableObjects:{AGENT_SHELL:{className:'AgentShell',useSQLite:true}},
  serviceBindings:{ASSETS:async request=>{
    const root=resolve('dist/client');
    let file=resolve(root,'.'+new URL(request.url).pathname);
    if(!file.startsWith(root+'/')) file=resolve(root,'index.html');
    let bytes;
    try {bytes=await readFile(file);} catch {file=resolve(root,'index.html'); bytes=await readFile(file);}
    const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'};
    return new Response(bytes,{headers:{'content-type':mime[extname(file)]||'application/octet-stream'}});
  }},
  bindings:{MODEL_REGISTRY:fixtureModelRegistry,APP_AUTH_MODE:'required',AGENT_RUNTIME_ENABLED:'true',FIRECRAWL_API_KEY:'synthetic-test-key',MODEL_API_KEY:'synthetic-test-key'},
  outboundService:async request=>{
    if (request.url === 'https://api.firecrawl.dev/v2/scrape') return Response.json({success:true,data:{markdown:'# Example product for readers'}});
    assert.equal(new URL(request.url).hostname,'model.invalid');
    assert.ok(requests++ < 8, 'Unexpected model decision');
    const body=await request.json();
    assert.ok(JSON.stringify(body.messages).includes('Synthetic business fixture'));
    const slotRows = await fixtureDb.prepare("select ref,value_json from agent_parameter_slots where kind='business_document'").all();
    const documentRefs = Object.fromEntries(slotRows.results.map(row=>[JSON.parse(row.value_json).key,row.ref]));
    let calls;
    if (requests === 1) calls=[{index:0,id:'page',type:'function',function:{name:'read_web_page',arguments:JSON.stringify({purpose:'Understand the product',url:'https://example.com'})}},{index:1,id:'documents',type:'function',function:{name:'read_business_documents',arguments:'{}'}}];
    else {
      const source=await fixtureDb.prepare('select id from research_sources limit 1').first();
      assert.ok(source?.id, 'Page snapshot must persist before generation: '+JSON.stringify(body.messages.filter(m=>m.role==='tool')));
      calls=['product','audience','brand','competition','marketing','conversion'].map((key,index)=>({index,id:'save-'+key,type:'function',function:{name:'save_business_document',arguments:JSON.stringify({document_ref:documentRefs[key],markdown:'# '+key+'\n\n## One-line introduction\n\nObserved public product. Unknowns remain explicit.',source_ids:[source.id]})}}));
      calls.push({index:calls.length,id:'finish',type:'function',function:{name:'finish_business_research',arguments:JSON.stringify({outcome:'completed',reason:'Six documents saved with page sources.',resume_when:''})}});
    }
    const chunks=[{id:'fixture',choices:[{index:0,delta:{role:'assistant',tool_calls:calls},finish_reason:null}]},
      {id:'fixture',choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}];
    return new Response(chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  },
}));
try {
  const db=await runtime.getD1Database('DB'); fixtureDb=db;
  const migrationDir=new URL('../migrations/',import.meta.url);
  for(const file of (await readdir(migrationDir)).filter(file=>file.endsWith('.sql')).sort()) {
    await db.exec((await readFile(new URL(file,migrationDir),'utf8')).replace(/'(?:''|[^'])*'|--[^\n]*/g, part => part.startsWith('--') ? '' : part).replace(/\n/g,' '));
  }
  await db.prepare("insert into sites(id,name,ingest_url,source_locale,translate_locales_json) values('s','Synthetic business fixture','https://synthetic.invalid','en','[]')").run();
  await db.prepare("insert into app_users(id,google_sub,email,display_name,created_at,last_login_at) values('fixture-user','synthetic','fixture@example.invalid','Local verifier',datetime('now'),datetime('now'))").run();
  await db.prepare("update workspaces set owner_user_id='fixture-user' where id='primary-workspace'").run();
  const login=await runtime.dispatchFetch('http://localhost/__fixture/login', {redirect:'manual'});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const root='http://localhost/api/sites/s';
  const denied=await runtime.dispatchFetch(root+'/agents/business_research/runs',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(denied.status,401);
  const retired=await runtime.dispatchFetch(root+'/agents/business_research/runs',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'});
  assert.equal(retired.status,405,'The retired generic start API stays unavailable');
  const response=await runtime.dispatchFetch('http://localhost/__fixture/start-business',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,202,await response.clone().text());
  const {run}=await response.json();
  let current;
  for(let n=0;n<60;n++) {
    current=await db.prepare('select status,reason as error from agent_tasks where id=?').bind(run.id).first();
    if(['completed','failed','cancelled'].includes(current.status)) break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.equal(current.status,'completed',JSON.stringify(current));
  const read=await runtime.dispatchFetch(root+'/business',{headers:{cookie}});
  const {modules}=await read.json();
  assert.equal(modules.length,6);
  assert.ok(modules.every(m=>m.version===1 && m.source==='website_research' && m.markdown.includes('https://example.com')));
  const processResponse=await runtime.dispatchFetch(root+'/business/research-process',{headers:{cookie}});
  assert.equal(processResponse.status,200);
  const trace=(await processResponse.json()).process;
  assert.equal(trace.metrics.saved_documents,6);
  assert.equal(trace.steps.filter(s=>s.tool==='save_business_document').length,6);

  const history=await db.prepare('select count(*) as n from agent_conversation_messages').first();
  assert.ok(history.n>5);
  console.log(JSON.stringify({verified:'authenticated fixture parent execution -> real child start service -> child Workflow -> native conversation -> page snapshot -> six Markdown versions -> API read-back; retired public start returns 405',parent:'fixture execution; no parent Workflow or model',model:'synthetic',browser:'synthetic public page response',documents:modules.length,conversation_messages:history.n}));
  if (process.env.VERIFY_BROWSER === '1') {
    console.log('Browser fixture ready at http://localhost:5200/__fixture/login');
    await new Promise(resolve=>process.once('SIGINT',resolve));
  }
} finally {await runtime.dispose();}
