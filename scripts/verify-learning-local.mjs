import { learningAcceptanceConfig } from './learning-acceptance-config.ts';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Explicitly invoked local acceptance only. State and external job receipts survive restarts.
if (process.env.VERIFY_REAL_RUNTIME !== '1')
  throw new Error(
    'Set VERIFY_REAL_RUNTIME=1 for the authorized real-provider local acceptance',
  );
const { vars } = learningAcceptanceConfig(true);
const state = resolve(
  process.env.LEARNING_STATE || '.wrangler/learning-acceptance-v3',
);
await mkdir(state, { recursive: true });
const bundled = await build({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: 'live-local-acceptance.ts',
    contents: `
  export {AgentRuntimeWorkflow} from './worker/agent-runtime/durable-workflow';
  export {AgentShell} from './worker/agent-runtime/shell';
  import worker from './worker/index';
  export { PublishWorkflow, LocalizeWorkflow, SiteRoom } from './worker/index';
  import { dispatchLearningRequests } from './worker/learning/dispatch';
  import { collectDueLearningOutcomes, materializeObservations } from './worker/learning/observations';
  import { encryptToken } from './worker/lib/gsc';
  import { listRecords, recordDetail } from './worker/learning/store';
  import {createSession,sessionCookie} from './worker/lib/auth/session';
  import {startConversation,wakeConversation} from './worker/growth-leader/service';
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
    if(path==='/__fixture/interrupt-execution' && request.method==='POST') {
      const body=await request.json(),execution=await currentExecution(env.DB,body.run_id);
      if(!execution) return Response.json({error:'No execution'},{status:404});
      const instance=await env.AGENT_WORKFLOW.get(execution.workflow_id);
      await instance.terminate();
      await reconcileTaskExecutions(env);
      return Response.json({run_id:body.run_id,interrupted_execution:execution.id});
    }
    if(path==='/__fixture/settle' && request.method==='POST') {
      const body=await request.json(); const execution=await currentExecution(env.DB,body.run_id);
      if(!execution) return Response.json({error:'No persisted execution'},{status:404});
      return Response.json(await settleRuntimeCheckpoint(env,authorityForExecution(execution)));
    }
    if(path==='/__fixture/learning') {
      const scope={workspaceId:'primary-workspace',siteId:'learning-site'};
      const rows=await listRecords(env.DB,scope);
      return Response.json({records:await Promise.all(rows.records.map(r=>recordDetail(env.DB,scope,r.id))),requests:(await env.DB.prepare('select * from learning_requests order by created_at,id').all()).results,observations:(await env.DB.prepare('select * from learning_observations').all()).results});
    }
    if(path==='/__fixture/gsc' && request.method==='POST') {
      const body=await request.json();
      await env.DB.prepare("insert into acceptance_config(id,value) values('gsc_mode',?) on conflict(id) do update set value=excluded.value").bind(body.mode||'low').run();
      const cipher=await encryptToken('SYNTHETIC_LOCAL_REFRESH_TOKEN',env.GSC_TOKEN_CIPHER_KEY);
      await env.DB.prepare("update sites set gsc_refresh_token_cipher=?,gsc_property_url_prefix='https://learning.example.invalid/' where id='learning-site'").bind(cipher).run();
      await materializeObservations(env);
      await env.DB.prepare("update learning_observations set status='pending',available_at='2000-01-01T00:00:00Z'"+(body.record_id?' where record_id=?':'')).bind(...(body.record_id?[body.record_id]:[])).run();
      return Response.json(await collectDueLearningOutcomes(env,new Date('2040-01-01T00:00:00Z')));
    }
    if(path==='/__fixture/reports') {
      const tasks=(await env.DB.prepare('select id,agent_id,status,output_json,reason from agent_tasks order by created_at').all()).results;
      return Response.json(await Promise.all(tasks.map(async t=>({...t,output:await readRuntimeJson(env.DB,t.output_json),output_json:undefined}))));
    }
    if(path==='/__fixture/request') return Response.json({url:request.url,origin:request.headers.get('Origin'),host:request.headers.get('Host')});
    if(path==='/__fixture/start' && request.method==='POST') {
      const body=await request.json();
      const id=body.id || crypto.randomUUID();
      await startConversation(env,{workspaceId:'primary-workspace',siteId:'learning-site'},{id,title:'Local business learning practice',message:{id:id+':input',text:body.goal || 'Plan one workplace email experiment. Prepare the practice, use relevant lessons if appropriate, and record your delivered plan. Do not delegate or publish.'}},'learning-user');
      await wakeConversation(env,{workspaceId:'primary-workspace',siteId:'learning-site'},id);
      return Response.json({id});
    }
    if(path==='/__fixture/seed' && request.method==='POST') {
      const library=new KeywordLibrary(env.DB,{workspace_id:'primary-workspace',site_id:'learning-site',locale:'en'});
      const candidates=[['difficult','how to reply politely to a difficult email','Respond calmly to an accusatory client email without admitting unsupported fault'],['deadline','how to push back on an unrealistic deadline by email','Respond to a manager requesting an impossible deadline while proposing a feasible alternative'],['decline','how to politely decline additional work by email','Decline an extra assignment while preserving the working relationship, with practical context cautions']];
      for(const [key,name,scenario] of candidates) {
        const op={operation_id:'acceptance-seed-'+key,actor:{type:'human',id:'learning-user'},reason:'Explicitly synthetic local business brief; not real search research'};
        await library.create('keyword',name,{intents:['informational'],audiences:['professionals handling difficult workplace requests'],scenarios:[scenario],business_relevance:'A distinct reader task for the concrete examples with contextual cautions pilot.',uncertainties:['Search demand is unmeasured'],evidence:[{source:'Synthetic local acceptance brief',observed_at:'2026-10-23T00:00:00Z',observation:scenario}]},op);
      }
      return Response.json({ok:true});
    }
    if(path==='/__fixture/library') {
      return Response.json({entries:(await env.DB.prepare('select * from keyword_library_entries').all()).results,links:(await env.DB.prepare('select * from keyword_library_topic_links').all()).results,logs:(await env.DB.prepare('select * from keyword_library_logs').all()).results,topics:(await env.DB.prepare('select * from topics').all()).results,decisions:(await env.DB.prepare('select * from topic_decision_results').all()).results});
    }
    if(path==='/__fixture/login') {
      const user=await env.DB.prepare("select * from app_users where id='learning-user'").first();
      const workspace=await env.DB.prepare("select * from workspaces where id='primary-workspace'").first();
      return new Response(null,{status:302,headers:{Location:'/website/learning-site/cabinet?category=experience','Set-Cookie':sessionCookie(new URL(request.url),await createSession(env.DB,{user,workspace}))}});
    }
    if(path==='/__fixture/reconcile' && request.method==='POST') {
      await reconcileTaskExecutions(env); await dispatchLearningRequests(env); await reconcileFirecrawlCancellations(env); return Response.json({ok:true});
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
`,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  external: ['cloudflare:*', 'node:*'],
  plugins: [
    {
      name: 'node-path',
      setup(b) {
        b.onResolve({ filter: /^path$/ }, () => ({
          path: 'path',
          namespace: 'shim',
        }));
        b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
          contents: "export * from 'node:path';",
          loader: 'js',
        }));
      },
    },
  ],
});
let fixtureDb;
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    host: '127.0.0.1',
    port: Number(process.env.LEARNING_PORT || 5211),
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-08-18',
    compatibilityFlags: ['nodejs_compat'],
    resourcePersistencePath: state,
    d1Databases: ['DB'],
    r2Buckets: ['RESEARCH_BUCKET'],
    durableObjects: {
      AGENT_SHELL: { className: 'AgentShell', useSQLite: true },
      SITE_ROOM: { className: 'SiteRoom', useSQLite: true },
    },
    workflows: {
      AGENT_WORKFLOW: {
        name: 'acceptance-runtime',
        className: 'AgentRuntimeWorkflow',
      },
      PUBLISH_WORKFLOW: { name: 'local-publish', className: 'PublishWorkflow' },
      LOCALIZE_WORKFLOW: {
        name: 'local-localize',
        className: 'LocalizeWorkflow',
      },
    },
    bindings: {
      ...vars,
      AUTH_LOGIN_METHODS: 'password',
      GOOGLE_CLIENT_ID: 'synthetic-local',
      GOOGLE_CLIENT_SECRET: 'synthetic-local',
      GSC_TOKEN_CIPHER_KEY: 'ab'.repeat(32),
      APP_AUTH_MODE: 'required',
      AGENT_RUNTIME_ENABLED: 'true',
    },
    serviceBindings: {
      ASSETS: async (request) => {
        const root = resolve('dist/client');
        let file = resolve(root, '.' + new URL(request.url).pathname);
        if (!file.startsWith(root + '/')) file = resolve(root, 'index.html');
        let bytes;
        try {
          bytes = await readFile(file);
        } catch {
          file = resolve(root, 'index.html');
          bytes = await readFile(file);
        }
        return new Response(bytes, {
          headers: {
            'content-type':
              {
                '.html': 'text/html',
                '.js': 'application/javascript',
                '.css': 'text/css',
                '.svg': 'image/svg+xml',
              }[extname(file)] || 'application/octet-stream',
          },
        });
      },
    },
    outboundService: async (request) => {
      const host = new URL(request.url).hostname;
      if (host === 'oauth2.googleapis.com')
        return Response.json({
          access_token: 'SYNTHETIC_LOCAL_ACCESS_TOKEN',
          expires_in: 3600,
        });
      if (
        host === 'www.googleapis.com' &&
        request.url.includes('/searchAnalytics/query')
      ) {
        const body = await request.json();
        await fixtureDb
          .prepare(
            'insert into acceptance_google_requests(body_json) values(?)',
          )
          .bind(JSON.stringify(body))
          .run();
        const mode =
          (
            await fixtureDb
              .prepare(
                "select value from acceptance_config where id='gsc_mode'",
              )
              .first()
          )?.value || 'low';
        if (mode === 'empty') return Response.json({ rows: [] });
        const days =
          Math.round(
            (Date.parse(body.endDate) - Date.parse(body.startDate)) / 86400000,
          ) + 1;
        const clicks = mode === 'high' ? 3 : mode === 'correction' ? 0 : 1;
        return Response.json({
          rows: body.startRow
            ? []
            : Array.from({ length: days }, (_, i) => ({
                keys: [
                  new Date(Date.parse(body.startDate) + i * 86400000)
                    .toISOString()
                    .slice(0, 10),
                ],
                clicks,
                impressions: 100,
                ctr: clicks / 100,
                position: 15,
              })),
          ...(mode === 'late'
            ? { metadata: { first_incomplete_date: body.endDate } }
            : {}),
        });
      }
      if (host === 'www.googleapis.com' && request.url.includes('/sitemaps'))
        return new Response(null, { status: 204 });
      const headers = new Headers(request.headers);
      for (const name of [
        'host',
        'connection',
        'content-length',
        'transfer-encoding',
        'accept-encoding',
      ])
        headers.delete(name);
      try {
        return await fetch(request.url, {
          method: request.method,
          headers,
          signal: request.signal,
          ...(request.method === 'GET' || request.method === 'HEAD'
            ? {}
            : { body: await request.arrayBuffer() }),
        });
      } catch (error) {
        console.error(
          'Provider connection failure',
          new URL(request.url).hostname,
          error.cause?.code || '',
          error.cause?.message || error.message,
        );
        throw error;
      }
    },
  }),
);
try {
  const db = await runtime.getD1Database('DB');
  fixtureDb = db;
  await db.exec(
    'create table if not exists acceptance_config(id text primary key,value text); create table if not exists acceptance_google_requests(id integer primary key,body_json text);',
  );
  await db.exec(
    'create table if not exists acceptance_migrations(name text primary key);',
  );
  const migrationDir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrationDir))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (
      await db
        .prepare('select 1 from acceptance_migrations where name=?')
        .bind(file)
        .first()
    )
      continue;
    await db.exec(
      (await readFile(new URL(file, migrationDir), 'utf8'))
        .replace(/'(?:''|[^'])*'|--[^\n]*/g, (part) =>
          part.startsWith('--') ? '' : part,
        )
        .replace(/\n/g, ' '),
    );
    await db
      .prepare('insert into acceptance_migrations(name) values(?)')
      .bind(file)
      .run();
  }
  if (
    !(await db.prepare("select 1 from sites where id='learning-site'").first())
  ) {
    const site = {
      id: 'public-synthetic',
      name: 'Business learning — local acceptance',
    };
    await db
      .prepare(
        "insert into sites(id,name,ingest_url,source_locale,translate_locales_json) values('learning-site',?,'https://example.invalid/email-guide','en','[]')",
      )
      .bind(site.name)
      .run();
    await db
      .prepare(
        "update sites set domain='learning.example.invalid',domain_status='live' where id='learning-site'",
      )
      .run();
    const documents = {
      product:
        'Synthetic business: a free educational guide to workplace emails. Independent keyword libraries define candidate needs. No customers, revenue or search-volume claims are known.',
      audience:
        'Professionals writing English emails, including Brazilian Portuguese-speaking readers. First-contact structure and replying politely to a difficult message are separate reader tasks. The saved first-contact topic does not address reply tone.',
      brand:
        'Plain, helpful and practical. No affiliation, paid product or customer outcomes are asserted.',
      conversion:
        'Reader success means completing the workplace writing task; no paid conversion is claimed.',
      marketing:
        'This is an explicitly synthetic local pilot: the business target is 10 GSC clicks per article in the first 7 publication days. The claim to test is that concrete response examples with contextual cautions serve distinct workplace email needs. Clicks are a proxy for discovery, not conversions. Topics should serve the selected language market. No human one-topic limit or wait-for-metrics rule exists. Search demand is unknown and must remain labelled unknown.',
      competition:
        'Known assets are discoverable through topic and article tools. Avoid duplicate reader needs; a shared keyword alone is not duplication.',
    };
    for (const [key, markdown] of Object.entries(documents))
      await db
        .prepare(
          "insert into business_module_versions(id,site_id,module_key,version,content_json,markdown,source) values(?,'learning-site',?,1,?,?,'manual')",
        )
        .bind(
          'public-fixture-' + key,
          key,
          JSON.stringify({ summary: markdown }),
          markdown,
        )
        .run();
    await db
      .prepare(
        "insert into app_users(id,google_sub,email,display_name,created_at,last_login_at) values('learning-user','local-acceptance','acceptance@example.invalid','Local acceptance',datetime('now'),datetime('now'))",
      )
      .run();
    await db
      .prepare(
        "update workspaces set owner_user_id='learning-user' where id='primary-workspace'",
      )
      .run();
    await writeFile(
      resolve(state, 'fixture.json'),
      JSON.stringify(
        {
          scope: 'local_only',
          source_site: site.id,
          documents: Object.keys(documents).length,
          created_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
  const seeded = await runtime.dispatchFetch(
    'http://localhost/__fixture/seed',
    { method: 'POST' },
  );
  if (!seeded.ok)
    throw new Error('Local keyword seed failed: ' + (await seeded.text()));
  console.log(
    'Persistent real-provider acceptance ready: ' +
      new URL('/__fixture/login', await runtime.ready),
  );
  const recovery = setInterval(
    () =>
      runtime
        .dispatchFetch('http://localhost/__fixture/reconcile', {
          method: 'POST',
        })
        .catch((error) => console.error('Local recovery tick:', error.message)),
    10000,
  );
  try {
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    clearInterval(recovery);
  }
} finally {
  await runtime.dispose();
}
