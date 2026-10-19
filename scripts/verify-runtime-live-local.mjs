import { localConfiguration, checkLocalConfiguration } from './configuration.ts';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Explicitly invoked local acceptance only. State and external job receipts survive restarts.
if(process.env.VERIFY_REAL_RUNTIME!=='1') throw new Error('Set VERIFY_REAL_RUNTIME=1 for the authorized real-provider local acceptance');
const { env: vars } = localConfiguration();
checkLocalConfiguration(true);
if (!vars.FIRECRAWL_API_KEY) throw new Error('FIRECRAWL_API_KEY is required for this research acceptance');
const state=resolve('.wrangler/continuous-acceptance'); await mkdir(state,{recursive:true});
const bundled=await build({stdin:{resolveDir:process.cwd(),sourcefile:'live-local-acceptance.ts',contents:`
  export {AgentRuntimeWorkflow} from './worker/agent-runtime/durable-workflow';
  export {AgentShell} from './worker/agent-runtime/shell';
  import worker from './worker/index';
  import {createSession,sessionCookie} from './worker/lib/auth/session';
  import {startRuntimeRun} from './worker/agent-runtime/run-service';
  import {createAgentRun,getAgentRun} from './worker/agent-runtime/store';
  import {attachTask} from './worker/agent-runtime/task-store';
  import {agentDefinition} from './worker/agent-runtime/definitions';
  import {reconcileTaskExecutions} from './worker/agent-runtime/task-recovery';
  import {reconcileFirecrawlCancellations} from './worker/agent-runtime/firecrawl-research';
  import {readRuntimeJson} from './worker/agent-runtime/runtime-content';
  import {settleRuntimeCheckpoint} from './worker/agent-runtime/runtime-checkpoint';
  import {currentExecution,authorityForExecution} from './worker/agent-runtime/runtime-executions';
  export default {async fetch(request,env,ctx) {
    const path=new URL(request.url).pathname;
    if(path==='/__fixture/login') {
      const user=await env.DB.prepare("select * from app_users where id='acceptance-user'").first();
      const workspace=await env.DB.prepare("select * from workspaces where id='primary-workspace'").first();
      return new Response(null,{status:302,headers:{Location:'/website/acceptance-site/strategy','Set-Cookie':sessionCookie(new URL(request.url),await createSession(env.DB,{user,workspace}))}});
    }
    if(path==='/__fixture/reconcile' && request.method==='POST') {
      await reconcileTaskExecutions(env); await reconcileFirecrawlCancellations(env); return Response.json({ok:true});
    }
    if(path==='/__fixture/recover-host' && request.method==='POST') {
      const rows=(await env.DB.prepare("select e.workflow_id from agent_runtime_executions e join agent_tasks t on t.execution_id=e.id where t.site_id='acceptance-site' and t.status='running' and e.status='running'").all()).results;
      for(const row of rows) {const instance=await env.AGENT_WORKFLOW.get(row.workflow_id);try{await instance.terminate();}finally{instance[Symbol.dispose]?.();}}
      await reconcileTaskExecutions(env);return Response.json({terminated:rows.length});
    }
    if(path==='/__fixture/finalize' && request.method==='POST') {
      const completed=(await env.DB.prepare("select active_run_id from agent_tasks where site_id='acceptance-site' and status in ('completed','failed') and execution_id!=''").all()).results;
      for(const row of completed) {const execution=await currentExecution(env.DB,row.active_run_id);if(execution) await settleRuntimeCheckpoint(env,authorityForExecution(execution));}
      const child=await env.DB.prepare("select id,status,outcome,reason from agent_tasks where parent_task_id='acceptance-external-job-parent'").first();
      if(!child || !['completed','failed','cancelled'].includes(child.status)) return Response.json({error:'External job is not terminal'},{status:409});
      const output=JSON.stringify({fixture:true,child_result:child});
      await env.DB.batch([
        env.DB.prepare("update agent_tasks set status='completed',outcome=?,reason='External job lifecycle verification settled',output_json=?,updated_at=datetime('now') where id='acceptance-external-job-parent' and status='waiting'").bind(child.status==='completed'?'completed':'partial',output),
        env.DB.prepare("update agent_runs set status='succeeded',phase='completed',output_json=?,finished_at=datetime('now'),updated_at=datetime('now') where id='acceptance-external-job-parent'").bind(output),
      ]);
      return Response.json({ok:true,child_result:child});
    }
    if(path==='/__fixture/research' && request.method==='POST') {
      const previous=await env.DB.prepare("select id from agent_runs where agent_instance_id='acceptance-firecrawl' order by created_at limit 1").first();
      if(previous) return Response.json({run_id:previous.id,reused:true});
      const parentId='acceptance-external-job-parent';
      const definition=agentDefinition('runtime_synthetic');
      const parent=await getAgentRun(env.DB,parentId) || await createAgentRun(env.DB,{id:parentId,workspaceId:'primary-workspace',siteId:'acceptance-site',agentId:definition.id,instanceId:'external-job-acceptance',definitionVersion:definition.definitionVersion,promptVersion:definition.promptVersion,trigger:'manual',summary:{fixture:'Hold a synthetic parent while one real external research job completes'}});
      await attachTask(env.DB,parent,definition);
      const run=await startRuntimeRun(env,{workspaceId:'primary-workspace',siteId:'acceptance-site',agentId:'deep_research',instanceId:'acceptance-firecrawl',trigger:'sub_agent',parentRunId:parent.id,summary:{research_question:'According to the official Cloudflare Workflows limits page, what are the current maximum non-stream step result size and steps per Workflow on paid plans?',decision_use:'Validate the external research integration against a narrow primary-source question.',scope:'Only https://developers.cloudflare.com/workflows/reference/limits/; English; current documented limits.',deliverable:'A short supported answer with source quotes and explicit uncertainty.',context:'This is an integration acceptance task, not a request to discover additional topics.',locale:'en'}});
      await env.DB.prepare("update agent_tasks set status='waiting',outcome='child_result',reason='Waiting for the acceptance job' where id=?").bind(parent.id).run();
      await env.DB.prepare("update agent_runs set status='waiting_for_input' where id=?").bind(parent.id).run();
      return Response.json({task_id:run.id,run_id:run.id});
    }
    if(path==='/__fixture/evidence') {
      const tasks=(await env.DB.prepare('select id,agent_id,status,outcome,reason,epoch,next_turn,model_calls,execution_id from agent_tasks order by created_at').all()).results;
      const executions=(await env.DB.prepare('select id,task_id,epoch,status,durable_steps,reason from agent_runtime_executions order by created_at').all()).results;
      const jobs=(await env.DB.prepare('select task_id,job_id,status,credits_used,error from firecrawl_research_jobs').all()).results;
      const cache=(await env.DB.prepare('select request_id,prefix_hash,tool_hash,compaction_version,cache_json from agent_model_request_observations').all()).results;
      const sources=(await env.DB.prepare('select id,object_key from research_sources').all()).results;
      const objects=[]; for(const source of sources) objects.push({id:source.id,key:source.object_key,exists:Boolean(await env.RESEARCH_BUCKET.head(source.object_key))});
      const versions=(await env.DB.prepare("select id,run_id,version,status,change_summary from seo_strategy_versions").all()).results;
      const compactions=(await env.DB.prepare('select task_id,version,through_sequence,length(summary_json) as summary_chars from agent_conversation_compactions').all()).results;
      const conversations=(await env.DB.prepare('select task_id,normal_decisions from agent_conversations').all()).results;
      const tools=(await env.DB.prepare("select task_id,json_extract(action_json,'$.name') as name,status,count(*) as count from agent_task_operations group by task_id,name,status").all()).results;
      const materials=(await env.DB.prepare("select module_key,version,source from business_module_versions").all()).results;
      const artifacts={territories:(await env.DB.prepare('select count(*) as n from seo_topic_territories').first()).n,clusters:(await env.DB.prepare('select count(*) as n from seo_keyword_clusters').first()).n,keywords:(await env.DB.prepare('select count(*) as n from seo_strategy_keywords').first()).n};
      return Response.json({tasks,executions,jobs,cache,objects,versions,compactions,conversations,tools,materials,artifacts});
    }
    if(path==='/__fixture/model-input') {
      const rows=(await env.DB.prepare('select request_id,wire_json from agent_model_request_observations order by rowid limit 2').all()).results;
      return Response.json(await Promise.all(rows.map(async row=>({request_id:row.request_id,wire:await readRuntimeJson(env.DB,row.wire_json)}))));
    }
    return worker.fetch(request,env,ctx);
  }};
`},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:*','node:*'],plugins:[{name:'node-path',setup(b){b.onResolve({filter:/^path$/},()=>({path:'path',namespace:'shim'}));b.onLoad({filter:/.*/,namespace:'shim'},()=>({contents:"export * from 'node:path';",loader:'js'}));}}]});
const runtime=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:5198,modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-08-18',compatibilityFlags:['nodejs_compat'],
  resourcePersistencePath:state,d1Databases:['DB'],r2Buckets:['RESEARCH_BUCKET'],
  durableObjects:{AGENT_SHELL:{className:'AgentShell',useSQLite:true}},
  workflows:{AGENT_WORKFLOW:{name:'acceptance-runtime',className:'AgentRuntimeWorkflow'}},
  bindings:{...vars,APP_AUTH_MODE:'required',AGENT_RUNTIME_ENABLED:'true'},
  serviceBindings:{ASSETS:async request=>{
    const root=resolve('dist/client'); let file=resolve(root,'.'+new URL(request.url).pathname);
    if(!file.startsWith(root+'/')) file=resolve(root,'index.html'); let bytes;
    try{bytes=await readFile(file);}catch{file=resolve(root,'index.html');bytes=await readFile(file);}
    return new Response(bytes,{headers:{'content-type':({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream'}});
  }},
  outboundService:async request=> {
    const headers=new Headers(request.headers);
    for(const name of ['host','connection','content-length','transfer-encoding','accept-encoding']) headers.delete(name);
    try {
      return await fetch(request.url,{method:request.method,headers,signal:request.signal,...(request.method==='GET'||request.method==='HEAD'?{}:{body:await request.arrayBuffer()})});
    } catch(error) {
      console.error('Provider connection failure',new URL(request.url).hostname,error.cause?.code||'',error.cause?.message||error.message);
      throw error;
    }
  },
}));
try {
  const db=await runtime.getD1Database('DB');
  await db.exec('create table if not exists acceptance_migrations(name text primary key);');
  const migrationDir=new URL('../migrations/',import.meta.url);
  for(const file of (await readdir(migrationDir)).filter(f=>f.endsWith('.sql')).sort()) {
    if(await db.prepare('select 1 from acceptance_migrations where name=?').bind(file).first()) continue;
    await db.exec((await readFile(new URL(file,migrationDir),'utf8')).replace(/'(?:''|[^'])*'|--[^\n]*/g,part=>part.startsWith('--')?'':part).replace(/\n/g,' '));
    await db.prepare('insert into acceptance_migrations(name) values(?)').bind(file).run();
  }
  if(!await db.prepare("select 1 from sites where id='acceptance-site'").first()) {
    const site={id:'public-synthetic',name:'Workflow Documentation Guide - fictional acceptance fixture'};
    await db.prepare("insert into sites(id,name,ingest_url,source_locale,translate_locales_json) values('acceptance-site',?,'https://developers.cloudflare.com/workflows/','en','[]')").bind(site.name).run();
    const documents={
      product:'Fictional acceptance business: an independent educational guide to public Cloudflare Workflows documentation. No affiliation, customers, revenue, product claims or competitive advantage are asserted.',
      audience:'Synthetic target audience: developers learning durable execution from official public documentation. No private customer data is provided.',
      brand:'This is a fictional free documentation guide. Revenue and commercial conversion are unknown; do not invent pricing or customer outcomes.',
      conversion:'Hypothetical goal: readers find the relevant official Cloudflare documentation page. No lead collection, publication or external messaging is requested.',
      marketing:'Research scope for acceptance: a small English documentation navigation pilot about Workflows limits and durable execution. Clearly mark unmeasured search demand. Prefer official Cloudflare primary sources.',
      competition:'Only public information may leave this fixture. Use the six supplied synthetic documents as complete initial business material. Produce a small honest pilot strategy and save it if the evidence supports it; no need for a broad competitive study.'
    };
    for(const [key,markdown] of Object.entries(documents)) await db.prepare("insert into business_module_versions(id,site_id,module_key,version,content_json,markdown,source) values(?,'acceptance-site',?,1,?,?,'local_acceptance')").bind('public-fixture-'+key,key,JSON.stringify({summary:markdown}),markdown).run();
    await db.prepare("insert into app_users(id,google_sub,email,display_name,created_at,last_login_at) values('acceptance-user','local-acceptance','acceptance@example.invalid','Local acceptance',datetime('now'),datetime('now'))").run();
    await db.prepare("update workspaces set owner_user_id='acceptance-user' where id='primary-workspace'").run();
    await writeFile(resolve(state,'fixture.json'),JSON.stringify({scope:'local_only',source_site:site.id,documents:Object.keys(documents).length,created_at:new Date().toISOString()},null,2));
  }
  console.log('Persistent real-provider acceptance ready: '+new URL('/__fixture/login',await runtime.ready));
  const recovery=setInterval(()=>runtime.dispatchFetch('http://localhost/__fixture/reconcile',{method:'POST'}).catch(error=>console.error('Local recovery tick:',error.message)),60000);
  try {await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});}
  finally {clearInterval(recovery);}
} finally {await runtime.dispose();}
