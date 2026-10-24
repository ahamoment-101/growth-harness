// Real local Worker/D1 and authorized API readback. No external calls or model simulation claims.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const port = Number(process.env.LEARNING_PORT || 5224);
const bundle = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'offline-learning-fixture.ts', contents: `
  import worker from './worker/index';
  export {AgentRuntimeWorkflow,AgentShell,SiteRoom,PublishWorkflow,LocalizeWorkflow} from './worker/index';
  import {createPractice,commitRecords,recordView,requireRecord} from './worker/learning/store';
  import {searchLearning,processLearningSearch} from './worker/learning/search';
  import {createSession,sessionCookie} from './worker/lib/auth/session';
  const scope={workspaceId:'primary-workspace',siteId:'learning-site'};
  export default {async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==='/__fixture/login'){
      const user=await env.DB.prepare("select * from app_users where id='learning-user'").first();
      const workspace=await env.DB.prepare("select * from workspaces where id='primary-workspace'").first();
      return new Response(null,{status:302,headers:{Location:'/website/learning-site/cabinet?category=experience','Set-Cookie':sessionCookie(url,await createSession(env.DB,{user,workspace}))}});
    }
    if(url.pathname==='/__fixture/practice'){
      const row=await createPractice(env.DB,scope,'synthetic-practice','growth_leader','Help readers respond to unrealistic deadlines',{id:'offline-lesson',material:{source:'Synthetic offline fixture'}});
      const data=recordView(row);
      data.intent.context='Synthetic educational workplace guide';
      data.experience.hypothesis='Concrete replies with contextual cautions help readers choose a feasible response.';
      data.experience.delivery='A synthetic content brief, not a published article';
      data.experience.insight='Negotiate scope and timing; do not promise a date without evidence.';
      data.experience.preparation='skipped';
      data.experience.gaps=['Synthetic fixture; no prospective evaluation or real outcome.'];
      return Response.json(await commitRecords(env.DB,scope,'offline-record',{},[{previous:row,data,title:'Respond to an unrealistic deadline',status:'unavailable'}]));
    }
    if(url.pathname==='/__fixture/search') return Response.json({search:await searchLearning(env,scope,'deadline'),index:await processLearningSearch(env)});
    // Rewrite the fixture dispatch host so authenticated origin checks match the actual local server.
    url.host='127.0.0.1:${port}';url.protocol='http:';
    return worker.fetch(new Request(url,request),env,ctx);
  }};
` }, bundle: true, write: false, platform: 'browser', format: 'esm', external: ['cloudflare:*', 'node:*'], plugins: [{ name: 'node-path', setup(b) {
  b.onResolve({ filter: /^path$/ }, () => ({ path: 'path', namespace: 'shim' }));
  b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: "export * from 'node:path';", loader: 'js' }));
} }] });
let outbound = 0;
const runtime = new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port,modules:true,script:bundle.outputFiles[0].text,
  compatibilityDate:'2026-08-18',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['RESEARCH_BUCKET'],
  durableObjects:{AGENT_SHELL:{className:'AgentShell',useSQLite:true},SITE_ROOM:{className:'SiteRoom',useSQLite:true}},
  workflows:{AGENT_WORKFLOW:{name:'offline-learning',className:'AgentRuntimeWorkflow'}},
  bindings:{AUTH_LOGIN_METHODS:'password',AGENT_RUNTIME_ENABLED:'true'},
  outboundService:async()=>{outbound++;return new Response('External requests disabled',{status:503});},
  serviceBindings:{ASSETS:async request=>{
    const root=resolve('dist/client');let file=resolve(root,'.'+new URL(request.url).pathname);
    if(!file.startsWith(root+'/')) file=resolve(root,'index.html');
    let bytes;try{bytes=await readFile(file);}catch{file=resolve(root,'index.html');bytes=await readFile(file);}
    return new Response(bytes,{headers:{'content-type':({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream'}});
  }},
}));
try{
  const db=await runtime.getD1Database('DB');
  const migrations=(await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort();
  const apply=async f=>db.exec((await readFile('migrations/'+f,'utf8')).replace(/'(?:''|[^'])*'|--[^\n]*/g,p=>p.startsWith('--')?'':p).replace(/\n/g,' '));
  // Exercise upgrading an existing 0.1 installation, not just an empty schema.
  for(const f of migrations.filter(f=>Number(f.slice(0,4))<=81)) await apply(f);
  await db.exec("insert into sites(id,name,ingest_url,source_locale,translate_locales_json) values('learning-site','Synthetic learning acceptance','https://example.invalid/','en','[]'); insert into app_users(id,google_sub,email,display_name,created_at,last_login_at) values('learning-user','local:fixture','fixture@example.invalid','Local fixture',datetime('now'),datetime('now')); update workspaces set owner_user_id='learning-user' where id='primary-workspace';");
  for(const f of migrations.filter(f=>Number(f.slice(0,4))>81)) await apply(f);
  assert.equal((await db.prepare("select name from sites where id='learning-site'").first()).name,'Synthetic learning acceptance');
  const get=(path,cookie)=>runtime.dispatchFetch('http://127.0.0.1:'+port+path,{headers:cookie?{cookie}:{},redirect:'manual'});
  const seeded=await get('/__fixture/practice');assert.equal(seeded.status,200);const receipt=await seeded.json();
  const replay=await get('/__fixture/practice');assert.equal(replay.status,200);assert.deepEqual(await replay.json(),receipt);
  assert.equal((await db.prepare('select count(*) n from learning_revisions').first()).n,1);
  const missing=await(await get('/__fixture/search')).json();assert.equal(missing.search.status,'configuration_missing');assert.equal(missing.index.status,'configuration_missing');assert.equal(missing.search.coverage.pending,1);
  const path='/api/sites/learning-site/learning/records';assert.equal((await get(path)).status,401);
  const login=await get('/__fixture/login');const cookie=login.headers.get('set-cookie').split(';')[0];
  const list=await get(path,cookie);assert.equal(list.status,200);const rows=await list.json();assert.equal(rows.records.length,1);assert.equal(rows.records[0].utility.score,null);
  const detail=await(await get(path+'/offline-lesson',cookie)).json();assert.equal(detail.record.experience.delivery,'A synthetic content brief, not a published article');
  await db.exec("insert into workspaces(id,name,created_at) values('other','Other owner',datetime('now')); insert into sites(id,workspace_id,name,ingest_url,source_locale,translate_locales_json) values('other-site','other','Other site','https://example.invalid/','en','[]');");
  const denied=await get('/api/sites/other-site/learning/records',cookie);assert.ok([403,404].includes(denied.status));
  assert.equal((await get(path+'/missing',cookie)).status,404);
  assert.equal((await db.prepare('pragma foreign_key_check').all()).results.length,0);
  assert.equal(outbound,0);
  console.log(JSON.stringify({verified:'existing-install upgrade, atomic receipt replay, authorized list/detail, tenant isolation, missing semantic configuration, unknown Utility',migrations:migrations.length,externalRequests:outbound}));
  if(process.env.LEARNING_PREVIEW==='1'){
    console.log('Synthetic offline preview: '+new URL('/__fixture/login',await runtime.ready));
    await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  }
}finally{await runtime.dispose();}
