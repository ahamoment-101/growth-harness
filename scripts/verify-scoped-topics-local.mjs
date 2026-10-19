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
const state=resolve('.wrangler/scoped-topic-acceptance'); await mkdir(state,{recursive:true});
const bundled=await build({stdin:{resolveDir:process.cwd(),sourcefile:'live-local-acceptance.ts',contents:`
  export {AgentRuntimeWorkflow} from './worker/agent-runtime/durable-workflow';
  export {AgentShell} from './worker/agent-runtime/shell';
  import worker from './worker/index';
  import {createSession,sessionCookie} from './worker/lib/auth/session';
  import {topicInstance,scopedTopicSummary} from './worker/agent-runtime/topic-scope';
  import {KeywordLibrary} from './worker/keyword-library/service';
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
    if(path==='/__fixture/settle' && request.method==='POST') {
      const body=await request.json(); const execution=await currentExecution(env.DB,body.run_id);
      if(!execution) return Response.json({error:'No persisted execution'},{status:404});
      return Response.json(await settleRuntimeCheckpoint(env,authorityForExecution(execution)));
    }
    if(path==='/__fixture/request') return Response.json({url:request.url,origin:request.headers.get('Origin'),host:request.headers.get('Host')});
    if(path==='/__fixture/start' && request.method==='POST') {
      const body=await request.json();
      if(!['strategy_research','topic_decision'].includes(body.agent)) return Response.json({error:'invalid agent'},{status:400});
      const summary=body.agent==='strategy_research'?{locale:'en'}:scopedTopicSummary({locale:body.locale||'en',market:body.market||'us',group_size:2});
      const run=await startRuntimeRun(env,{workspaceId:'primary-workspace',siteId:'scoped-topic-site',agentId:body.agent,trigger:'manual',instanceId:body.agent==='topic_decision'?topicInstance(summary.scope):undefined,summary});
      return Response.json(run);
    }
    if(path==='/__fixture/seed' && request.method==='POST') {
      for(const [locale,market,name] of [['en','us','how to write a professional email'],['pt-BR','br','como escrever email profissional em inglês'],['en','gb','professional email etiquette']]) {
        const library=new KeywordLibrary(env.DB,{workspace_id:'primary-workspace',site_id:'scoped-topic-site',locale,market});
        if((await library.list()).items.length) continue;
        const op=id=>({operation_id:'seed-'+locale+'-'+market+'-'+id,actor:{type:'human',id:'scoped-topic-user'},reason:'Synthetic acceptance research'});
        const word=await library.create('keyword',name,{intents:['informational'],audiences:['professionals writing workplace emails'],scenarios:['first-contact email structure','replying politely to a difficult message'],business_relevance:'Free educational guide; reply tone is a distinct reader need from first contact.',uncertainties:['Search demand is unmeasured']},op('word'));
        const group=await library.create('topic_group','Workplace communication',{},op('group'));
        const cluster=await library.create('cluster','Professional email',{need:'Handle different workplace email situations'},op('cluster'));
        await library.membership(group.target_id, cluster.target_id, true,op('gc'));
        await library.membership(cluster.target_id, word.target_id, true,op('cw'));
        if(market==='us') {
          await env.DB.prepare("insert or ignore into topics(id,site_id,topic_key,title_hint,category,primary_keyword,status,plan_json) values('existing-first-contact','scoped-topic-site','existing-first-contact','Structure a first-contact professional email','GUIDE',?,'used',?)").bind(name,JSON.stringify({locale,market})).run();
          await library.linkTopic(word.target_id, 'existing-first-contact', 'Existing first-contact guide; does not address replying to difficult messages',op('existing-link'));
        }
      }
      return Response.json({ok:true});
    }
    if(path==='/__fixture/library') {
      return Response.json({entries:(await env.DB.prepare('select * from keyword_library_entries').all()).results,links:(await env.DB.prepare('select * from keyword_library_topic_links').all()).results,logs:(await env.DB.prepare('select * from keyword_library_logs').all()).results,topics:(await env.DB.prepare('select * from topics').all()).results,decisions:(await env.DB.prepare('select * from topic_decision_results').all()).results});
    }
    if(path==='/__fixture/login') {
      const user=await env.DB.prepare("select * from app_users where id='scoped-topic-user'").first();
      const workspace=await env.DB.prepare("select * from workspaces where id='primary-workspace'").first();
      return new Response(null,{status:302,headers:{Location:'/website/scoped-topic-site/keywords','Set-Cookie':sessionCookie(new URL(request.url),await createSession(env.DB,{user,workspace}))}});
    }
    if(path==='/__fixture/reconcile' && request.method==='POST') {
      await reconcileTaskExecutions(env); await reconcileFirecrawlCancellations(env); return Response.json({ok:true});
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
const runtime=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:5200,modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-08-18',compatibilityFlags:['nodejs_compat'],
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
  if(!await db.prepare("select 1 from sites where id='scoped-topic-site'").first()) {
    const site={id:'public-synthetic',name:'Scoped topics — synthetic email guide'};
    await db.prepare("insert into sites(id,name,ingest_url,source_locale,translate_locales_json) values('scoped-topic-site',?,'https://example.invalid/email-guide','en','[\"pt-BR\"]')").bind(site.name).run();
    const documents={
      product:'Synthetic business: a free educational guide to workplace emails. Independent keyword libraries define candidate needs. No customers, revenue or search-volume claims are known.',
      audience:'Professionals writing English emails, including Brazilian Portuguese-speaking readers. First-contact structure and replying politely to a difficult message are separate reader tasks. The saved first-contact topic does not address reply tone.',
      brand:'Plain, helpful and practical. No affiliation, paid product or customer outcomes are asserted.',
      conversion:'Reader success means completing the workplace writing task; no paid conversion is claimed.',
      marketing:'Topics should serve the selected language market. No human one-topic limit or wait-for-metrics rule exists. Search demand is unknown and must remain labelled unknown.',
      competition:'Known assets are discoverable through topic and article tools. Avoid duplicate reader needs; a shared keyword alone is not duplication.'
    };
    for(const [key,markdown] of Object.entries(documents)) await db.prepare("insert into business_module_versions(id,site_id,module_key,version,content_json,markdown,source) values(?,'scoped-topic-site',?,1,?,?,'manual')").bind('public-fixture-'+key,key,JSON.stringify({summary:markdown}),markdown).run();
    await db.prepare("insert into app_users(id,google_sub,email,display_name,created_at,last_login_at) values('scoped-topic-user','local-acceptance','acceptance@example.invalid','Local acceptance',datetime('now'),datetime('now'))").run();
    await db.prepare("update workspaces set owner_user_id='scoped-topic-user' where id='primary-workspace'").run();
    await db.prepare("insert into seo_strategy_versions(id,site_id,run_id,submission_operation_id,version,locale_version,status,source_locale,change_summary) values('old-ai-strategy','scoped-topic-site','synthetic-old-run','synthetic-strategy-op',1,1,'active','en','Historical AI recommendation')").run();
    await db.prepare("insert into seo_strategy_documents(id,strategy_version_id,doc_type,body_md,content_hash) values('old-ai-doc','old-ai-strategy','strategy',?,'synthetic')").bind('Historical AI recommendation from an earlier first-contact pilot: create only one email guide and wait for measurements before considering other needs. This was an AI recommendation, not an explicit human restriction. No reply-tone research was available at that time.').run();
    await writeFile(resolve(state,'fixture.json'),JSON.stringify({scope:'local_only',source_site:site.id,documents:Object.keys(documents).length,created_at:new Date().toISOString()},null,2));
  }
  await runtime.dispatchFetch('http://localhost/__fixture/seed',{method:'POST'});
  console.log('Persistent real-provider acceptance ready: '+new URL('/__fixture/login',await runtime.ready));
  const recovery=setInterval(()=>runtime.dispatchFetch('http://localhost/__fixture/reconcile',{method:'POST'}).catch(error=>console.error('Local recovery tick:',error.message)),60000);
  try {await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});}
  finally {clearInterval(recovery);}
} finally {await runtime.dispose();}
