import { fixtureModelRegistry } from './runtime-fixture-capabilities.mjs';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Real strategy dispatch, context, native conversation, Workflow, D1 and Shell. Synthetic model only.
const bundled = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'research-workflow-verifier.ts', contents: `
  export { AgentRuntimeWorkflow } from './worker/agent-runtime/durable-workflow';
  export { AgentShell } from './worker/agent-runtime/shell';
  import { getAgentByName } from 'agents';
  import { runtimeAgentName } from './worker/agent-runtime/definitions';
  import { startStrategyResearch } from './worker/lib/research/dispatch';
  import { strategyPayload } from './worker/lib/research/strategy-store';
  export default { async fetch(request, env) {
    const path=new URL(request.url).pathname;
    if(path==='/start') return Response.json(await startStrategyResearch(env,'s','manual','en'));
    if(path==='/payload') return Response.json(await strategyPayload(env.DB,'s','en',undefined,{controlsEnabled:true}));
    const run=await env.DB.prepare("select * from agent_runs where agent_id='strategy_research' order by created_at desc limit 1").first();
    if(path==='/snapshot' || path==='/cancel') {
      const shell=await getAgentByName(env.AGENT_SHELL,runtimeAgentName('primary-workspace','s','strategy_research','strategy:en'));
      try { return Response.json(path==='/cancel' ? await shell.cancelRun(run.id,'local-verifier','Cancellation fixture','cancel-fixture') : await shell.getSnapshot()); } finally { shell[Symbol.dispose]?.(); }
    }
    const instance=await env.AGENT_WORKFLOW.get(run.workflow_id);
    try { return Response.json(await instance.status()); } finally { instance[Symbol.dispose]?.(); }
  } };
` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'], plugins: [{ name: 'node-path-interop', setup(builder) { builder.onResolve({filter: /^path$/}, () => ({path: 'path', namespace: 'builtin-shim'})); builder.onLoad({filter: /.*/, namespace: 'builtin-shim'}, () => ({contents: "export * from 'node:path';", loader: 'js'})); } }] });

const longDecisions = process.env.VERIFY_LONG_RUNTIME === '1' ? 110 : 0;
const sequence = [];
for(let index=1;index<=longDecisions;index++) {
  sequence.push([{name:'read_strategy_workspace',arguments:{}}]);
  if(index%30===0) sequence.push([{name:'resolve_execution_audit',arguments:{decision:'continue',reason:'Synthetic recorded progress',progress:`${index} decisions`,remaining_work:'Complete the host handoff verification',next_stage_method:'Read the saved workspace',outcome:'partial',artifact_refs:[],unresolved_issues:[]}}]);
}
sequence.push([{name:'read_strategy_workspace',arguments:{}},{name:'finish_strategy',arguments:{outcome:'no_change',reason:'Synthetic protocol verification',resume_when:'A real research request',judgment_summary:'No strategy claim is made from this synthetic fixture.'}}]);
let requests=0;
let releaseModel;
let notifyBlocked;
const blocked=new Promise(resolve=>{notifyBlocked=resolve;});
const modelGate=new Promise(resolve=>{releaseModel=resolve;});
const runtime=new Miniflare(convertV4MiniflareOptions({
  modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-08-18',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
  workflows:{AGENT_WORKFLOW:{name:'local-strategy',className:'AgentRuntimeWorkflow'}},
  durableObjects:{AGENT_SHELL:{className:'AgentShell',useSQLite:true}},
  bindings:{MODEL_REGISTRY:fixtureModelRegistry,AGENT_RUNTIME_ENABLED:'true',MODEL_API_KEY:'synthetic-test-key'},
  outboundService:async request=>{
    assert.equal(new URL(request.url).hostname,'model.invalid');
    const body=await request.json();
    if(!body.tools?.length) {
      const summary={id:'summary',choices:[{index:0,delta:{role:'assistant',content:'Synthetic business fixture. Preserve the original goal: verify a continuous strategy Task and Run across audits and Workflow handoff. No real business claims or submissions exist. Continue reading the workspace, then finish no_change. Successful read receipts are already persisted; do not repeat prior effects.'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}};
      return new Response('data: '+JSON.stringify(summary)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    }
    assert.ok(requests <= sequence.length, 'Unexpected model decision');
    const index=requests++;
    if(index === sequence.length) { notifyBlocked(); await modelGate; }
    assert.ok(JSON.stringify(body.messages).includes('Synthetic business fixture'));
    assert.ok(body.tools?.some(tool=>tool.function?.name==='resolve_execution_audit'),'Strategy receives autonomous audit control');
    const calls=(sequence[index] || sequence.at(-1)).map((call,callIndex)=>({index:callIndex,id:`call-${index}-${callIndex}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}));
    const chunks=[{id:'fixture',choices:[{index:0,delta:{role:'assistant',tool_calls:calls},finish_reason:null}]},
      {id:'fixture',choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}];
    return new Response(chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  },
}));
try {
  const db=await runtime.getD1Database('DB');
  const migrationDir=new URL('../migrations/',import.meta.url);
  for(const file of (await readdir(migrationDir)).filter(file=>file.endsWith('.sql')).sort()) {
    await db.exec((await readFile(new URL(file,migrationDir),'utf8')).replace(/'(?:''|[^'])*'|--[^\n]*/g, part => part.startsWith('--') ? '' : part).replace(/\n/g,' '));
  }
  await db.prepare("insert into sites(id,name,ingest_url,source_locale,translate_locales_json) values('s','Synthetic business fixture','https://synthetic.invalid','en','[]')").run();
  const response=await runtime.dispatchFetch('https://local.test/start');
  assert.equal(response.status,200);
  const started=await response.json();
  assert.ok(started.runId,JSON.stringify(started));
  let state;
  const deadline=Date.now()+120000;
  do {
    state=await (await runtime.dispatchFetch('https://local.test/status')).json();
    if(['complete','errored','terminated'].includes(state.status)) break;
    await new Promise(resolve=>setTimeout(resolve,250));
  } while(Date.now()<deadline);
  assert.equal(state.status,'complete',JSON.stringify(state));
  const payload=await (await runtime.dispatchFetch('https://local.test/payload')).json();
  assert.equal(payload.runtime.task.status,'completed',JSON.stringify({task:payload.runtime.task,requests,executions:(await db.prepare('select * from agent_runtime_executions').all()).results}));
  assert.equal(payload.runtime.task.outcome,'no_change');
  assert.equal(payload.runtime.task.next_turn,longDecisions+Math.floor(longDecisions/30)+3);
  assert.equal(payload.runtime.task.decision_turns,longDecisions+1);
  assert.equal(payload.runtime.run.status,'succeeded');
  assert.equal(JSON.parse(payload.runtime.run.output_json).decision_turns,longDecisions+1);
  assert.equal(payload.runtime.controls.cancel,false);
  const snapshot=await (await runtime.dispatchFetch('https://local.test/snapshot')).json();
  assert.equal(snapshot.run_id,started.runId); assert.equal(snapshot.status,'succeeded');
  assert.equal(requests,sequence.length);
  assert.equal((await db.prepare('select count(*) as n from agent_runtime_audits').first()).n,Math.floor(longDecisions/30)+1);
  const executions=(await db.prepare('select * from agent_runtime_executions order by epoch').all()).results;
  assert.equal(new Set(executions.map(row=>row.run_id)).size,1);
  assert.equal(new Set(executions.map(row=>row.task_id)).size,1);
  assert.ok(longDecisions ? executions.length>=2 : executions.length===1,JSON.stringify(executions));
  assert.ok(executions.every(row=>row.durable_steps<=200));
  console.log(JSON.stringify({normal_decisions:longDecisions+1,executions:executions.map(row=>({epoch:row.epoch,steps:row.durable_steps,status:row.status}))}));
  const second=await (await runtime.dispatchFetch('https://local.test/start')).json();
  assert.ok(second.runId,JSON.stringify(second));
  let timeout;
  try { await Promise.race([blocked,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Second model request did not start')),15000);})]); }
  finally {clearTimeout(timeout);}
  const cancelled=await runtime.dispatchFetch('https://local.test/cancel');
  assert.equal(cancelled.status,200,await cancelled.clone().text());
  releaseModel();
  const cancelledPayload=await (await runtime.dispatchFetch('https://local.test/payload')).json();
  assert.equal(cancelledPayload.runtime.task.status,'cancelled');
  assert.equal(cancelledPayload.runtime.run.status,'cancelled');
  assert.equal(cancelledPayload.runtime.task.revision,0);
  assert.equal(cancelledPayload.runtime.task.next_turn,1);
  assert.equal(cancelledPayload.runtime.controls.cancel,false);
  assert.equal((await (await runtime.dispatchFetch('https://local.test/status')).json()).status,'terminated');
  assert.equal((await (await runtime.dispatchFetch('https://local.test/snapshot')).json()).status,'cancelled');
  assert.equal(requests,sequence.length+1);
  console.log('Actual strategy start service -> Workflow -> Pi multi-tool decision -> D1 -> page payload and AgentShell passed. Two tools count as one decision. Model transport was synthetic; cancellation during model I/O also passed; browser/auth route not exercised.');
} finally {releaseModel(); await runtime.dispose();}
