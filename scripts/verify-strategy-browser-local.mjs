import { fixtureModelRegistry } from './runtime-fixture-capabilities.mjs';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Real strategy dispatch, context, native conversation, Workflow, D1 and Shell. Synthetic model only.
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
      return new Response(null,{status:302,headers:{Location:'/website/s/strategy','Set-Cookie':sessionCookie(new URL(request.url),token)}});
    }
    return worker.fetch(request,env,ctx);
  } };
` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'], plugins: [{ name: 'node-path-interop', setup(builder) { builder.onResolve({filter: /^path$/}, () => ({path: 'path', namespace: 'builtin-shim'})); builder.onLoad({filter: /.*/, namespace: 'builtin-shim'}, () => ({contents: "export * from 'node:path';", loader: 'js'})); } }] });

let requests=0;
let database;
let lastView;
const text = Object.fromEntries(['change_summary','research_scope_summary','executive_strategy','search_landscape','selected_playbooks','site_architecture','internal_linking','roadmap','measurement','risks_unknowns','evidence_notes'].map(key=>[key,'Synthetic pilot; evidence unknown']));
const territory = {name:'Learning',priority_band:'medium',status:'active',audience_summary:'Readers',search_job_summary:'Learn',business_goal:'Trial',conversion_goal:'Trial',summary:'Unknown'};
const cluster = {name:'Practice',priority_band:'medium',status:'active',strategic_role:'Practice',recommended_hub:'/guides',conversion_goal:'Trial',summary:'Unknown'};
function latestView(messages) {
  for(const message of [...messages].reverse()) if(message.role==='tool') {
    try {const value=JSON.parse(message.content);if(value.workspace_ref) return value;}catch{}
  }
  return lastView;
}
const runtime=new Miniflare(convertV4MiniflareOptions({
  host:'127.0.0.1',port:5199,modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-08-18',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
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
  bindings:{MODEL_REGISTRY:fixtureModelRegistry,APP_AUTH_MODE:'required',AGENT_RUNTIME_ENABLED:'true',MODEL_API_KEY:'synthetic-test-key'},
  outboundService:async request=>{
    assert.equal(new URL(request.url).hostname,'model.invalid');
    const body=await request.json();
    assert.ok(requests < 12,'Unexpected decision');
    lastView=latestView(body.messages);
    const index=requests++;
    let actions;
    const view=lastView;
    if(index===0 || index===4 || index===6) actions=[['read_strategy_workspace',{}]];
    if(index===1) actions=[['update_strategy_blueprint',{workspace_ref:view.workspace_ref,blueprint:text,territories:[{values:territory}]}]];
    if(index===2) actions=Array.from({length:2},()=>['read_strategy_workspace',{}]);
    if(index===3) actions=[['read_strategy_workspace',{}]];
    if(index===5) {
      await database.prepare("update agent_tasks set revision=revision+1 where agent_id='strategy_research'").run();
      actions=[['update_strategy_blueprint',{workspace_ref:view.workspace_ref,blueprint:{roadmap:'Must not overwrite concurrent revision'}}]];
    }
    if(index===7) {
      const workspace=JSON.parse(view.excerpt);
      actions=[['update_strategy_blueprint',{workspace_ref:view.workspace_ref,blueprint:{},clusters:[{territory_ref:workspace.blueprint.territories[0].ref,values:cluster}]}]];
    }
    if(index===8 || index===9) {
      const workspace=view.workspace || JSON.parse(view.excerpt);
      actions=[['update_strategy_keywords',{workspace_ref:view.workspace_ref,create:[{term:'language practice',market_ref:view.markets[0].ref,cluster_ref:workspace.blueprint.clusters[0].ref,source_refs:index===8?['invented-source']:[],existing_page:{state:'unknown',page_ref:''},intent:'informational',journey_stage:'problem',serp_shape:'Unknown',recommended_page_type:'guide',business_relevance:'Hypothesis',conversion_route:'Trial',priority_band:'medium',priority_rationale:'Unknown',coverage_status:'uncovered',decision:'watch',evidence_summary:'Unknown'}]}]];
    }
    if(index===10) actions=[['submit_strategy',{workspace_ref:view.workspace_ref,judgment_summary:'Synthetic pilot; no measured demand claimed'}]];
    if(index===11) actions=[['finish_strategy',{outcome:'completed',reason:'Saved synthetic strategy',resume_when:'',judgment_summary:'Synthetic protocol fixture only'}]];
    const calls=actions.map(([name,args],i)=>({index:i,id:`call-${index}-${i}`,type:'function',function:{name,arguments:JSON.stringify(args)}}));
    const chunks=[{id:'fixture',choices:[{index:0,delta:{role:'assistant',tool_calls:calls},finish_reason:null}]},
      {id:'fixture',choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}];
    return new Response(chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  },
}));
try {
  const db=database=await runtime.getD1Database('DB');
  const migrationDir=new URL('../migrations/',import.meta.url);
  for(const file of (await readdir(migrationDir)).filter(file=>file.endsWith('.sql')).sort()) {
    await db.exec((await readFile(new URL(file,migrationDir),'utf8')).replace(/'(?:''|[^'])*'|--[^\n]*/g, part => part.startsWith('--') ? '' : part).replace(/\n/g,' '));
  }
  await db.prepare("insert into sites(id,name,ingest_url,source_locale,translate_locales_json) values('s','Synthetic business fixture','https://synthetic.invalid','en','[]')").run();
  await db.prepare("insert into app_users(id,google_sub,email,display_name,created_at,last_login_at) values('fixture-user','synthetic','fixture@example.invalid','Local verifier',datetime('now'),datetime('now'))").run();
  await db.prepare("update workspaces set owner_user_id='fixture-user' where id='primary-workspace'").run();
  console.log('Isolated authenticated browser fixture ready at '+new URL('/__fixture/login',await runtime.ready));
  await new Promise(resolve=>{const timer=setTimeout(resolve,600000); process.once('SIGINT',()=>{clearTimeout(timer);resolve();});});
} finally {await runtime.dispose();}
