import { strategyTaskTools } from './strategy-task';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskTestDb, resumeTestTask } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, stopTask, taskForRun, beginTaskDecision } from './task-store';
import { runFirecrawlResearch, cancelFirecrawlResearch, reconcileFirecrawlCancellations, normalizeResearch } from './firecrawl-research';
import { researchPayload } from '../lib/research/firecrawl-agent';
import { resultForTask } from './research-contract';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';

const brief = { research_question: 'Compare publicly documented products', locale: 'pt-BR' };
const data = { outcome: 'partial', summary: 'Some evidence', report: 'One source; no market-size data',
  findings: [{ claim: 'A documented feature', kind: 'fact', citations: [{ url:'https://example.com/product',title:'Product',quote:'A documented feature',relation:'supports' }] }],
  unknowns: ['Brazil demand not measured'], reason: 'Partial evidence' };
const step = { do: async (_name: string, _config: unknown, action: () => Promise<unknown>) => action(), sleep: async () => {} } as unknown as RuntimeWorkflowStep;
const response = (value: unknown, status=200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const f = taskTestDb();
  const parent = await attachTask(f.db,f.run(),agentDefinition('strategy_research'));
  const run = { ...f.run(`child-${parent.id}-1`,'child'), agent_id:'deep_research' as const, parent_run_id:parent.active_run_id, summary_json:JSON.stringify(brief) };
  await f.db.prepare('update agent_runs set agent_id=?,parent_run_id=?,summary_json=? where id=?').bind(run.agent_id,run.parent_run_id,run.summary_json,run.id).run();
  const task = await attachTask(f.db,run,agentDefinition('deep_research'));
  const env = { DB:f.db,FIRECRAWL_API_KEY:'test-only' } as RuntimeAgentEnv;
  return { ...f,createRun:f.run,parent,task,env,run, input:{env,step,runId:task.active_run_id} };
}
describe('hosted Firecrawl research', () => {
  it('submits once, waits, retains raw results and replays without new calls or internal inference', async () => {
    const f = await fixture();
    const fetch = vi.fn().mockResolvedValueOnce(response({success:true,id:'provider-job'}))
      .mockResolvedValueOnce(response({success:true,status:'processing'}))
      .mockResolvedValueOnce(response({success:true,status:'completed',data,creditsUsed:17}));
    vi.stubGlobal('fetch',fetch);
    const result = await runFirecrawlResearch(f.input);
    expect(result.output).toMatchObject({outcome:'partial',unknowns:['Brazil demand not measured'],sources:[{evidence_type:'provider_excerpt'}]});
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({model:'spark-2'});
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty('maxCredits');
    expect(JSON.parse(fetch.mock.calls[0][1].body).prompt).toContain('pt-BR');
    expect(await runFirecrawlResearch(f.input)).toEqual({...result,phase:'completed'});
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await taskForRun(f.db,f.task.active_run_id)).toMatchObject({model_calls:0,status:'completed',external_calls:3});
    expect(await taskForRun(f.db,f.parent.active_run_id)).toMatchObject({model_calls:0,external_calls:3});
    const row = await f.db.prepare('select * from firecrawl_research_jobs where task_id=?').bind(f.task.id).first<{raw_json:string;credits_used:number;reserved_credits:number;request_json:string}>();
    expect(row!.reserved_credits).toBe(0);
    expect(JSON.parse(row!.request_json)).not.toHaveProperty('maxCredits');
    expect(JSON.parse(row!.raw_json)).toMatchObject({data,creditsUsed:17});
    expect(row!.credits_used).toBe(17);
    expect((await f.db.prepare('select count(*) as n from research_sources').first<{n:number}>())?.n).toBe(0);
  });
  it('resumes a saved job after polling fails without posting twice', async () => {
    const f = await fixture();
    const fetch = vi.fn().mockResolvedValueOnce(response({success:true,id:'saved-job'})).mockRejectedValueOnce(new Error('fetch failed'));
    vi.stubGlobal('fetch',fetch);
    await expect(runFirecrawlResearch(f.input)).rejects.toThrow('fetch failed');
    await resumeTestTask(f.db,f.task.active_run_id);
    fetch.mockResolvedValueOnce(response({success:true,status:'completed',data,creditsUsed:0}));
    expect((await runFirecrawlResearch(f.input)).output.outcome).toBe('partial');
    expect(fetch.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1);
  });
  it('does not resubmit after a submit timeout, even across executions', async () => {
    const f = await fixture();
    const fetch = vi.fn().mockRejectedValue(new Error('submit timed out'));
    vi.stubGlobal('fetch',fetch);
    expect((await runFirecrawlResearch(f.input)).output.outcome).toBe('paused');
    await resumeTestTask(f.db,f.task.active_run_id);
    expect((await runFirecrawlResearch(f.input)).output.reason).toContain('outcome unknown');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await f.db.prepare('select credits_used from firecrawl_research_jobs').first<{credits_used:number|null}>())?.credits_used).toBeNull();
  });
  it('preserves valid partial work when the provider reports failure', async () => {
    const f = await fixture();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response({success:true,id:'job'}))
      .mockResolvedValueOnce(response({status:'failed',error:'Max credits exceeded',data,creditsUsed:8})));
    expect((await runFirecrawlResearch(f.input)).output).toMatchObject({outcome:'failed',findings:[{claim:'A documented feature'}],reason:'Max credits exceeded'});
  });
  it('never mistakes an empty/invalid result for successful research', async () => {
    const f = await fixture();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response({success:true,id:'job'}))
      .mockResolvedValueOnce(response({status:'completed',data:{},creditsUsed:3})));
    expect((await runFirecrawlResearch(f.input)).output.outcome).toBe('failed');
    expect((await f.db.prepare('select raw_json from firecrawl_research_jobs').first<{raw_json:string}>())?.raw_json).toContain('"data":{}');
  });
  it('honors an explicitly configured credit cap without enforcing a root lifetime ceiling', async () => {
    const f=await fixture();
    f.env.FIRECRAWL_RESEARCH_MAX_CREDITS = '500';
    await f.db.prepare('update agent_tasks set max_external_calls=1').run();
    const fetch=vi.fn().mockResolvedValueOnce(response({success:true,id:'job'})).mockResolvedValueOnce(response({status:'completed',data,creditsUsed:17}));
    vi.stubGlobal('fetch',fetch);
    expect((await runFirecrawlResearch(f.input)).output.outcome).toBe('partial');
    expect(JSON.parse(fetch.mock.calls[0][1].body).maxCredits).toBe(500);
  });
  it('fences completion after cancellation and reconciles the provider bill', async () => {
    const f = await fixture();
    const fetch=vi.fn().mockResolvedValueOnce(response({success:true,id:'job'})).mockImplementationOnce(async () => {
      await stopTask(f.db,f.parent.active_run_id,'cancelled','User cancelled');
      return response({status:'processing'});
    }).mockResolvedValueOnce(response({status:'processing'})).mockResolvedValueOnce(response({success:true}));
    vi.stubGlobal('fetch',fetch);
    await expect(runFirecrawlResearch(f.input)).rejects.toThrow('Root task');
    await reconcileFirecrawlCancellations(f.env);
    expect(fetch.mock.calls.some(call=>call[1].method==='DELETE')).toBe(true);
    expect((await f.db.prepare('select status from firecrawl_research_jobs').first<{status:string}>())?.status).toBe('cancel_requested');
    fetch.mockResolvedValueOnce(response({status:'failed',error:'Cancelled',creditsUsed:4}));
    await reconcileFirecrawlCancellations(f.env);
    expect((await f.db.prepare('select status,credits_used from firecrawl_research_jobs').first())).toEqual({status:'cancelled',credits_used:4});
    expect((await taskForRun(f.db,f.task.active_run_id))?.status).not.toBe('completed');
  });
  it('cancels a known provider job without needing a live child workflow', async () => {
    const f=await fixture();
    const fetch=vi.fn().mockResolvedValueOnce(response({success:true,id:'job'})).mockRejectedValueOnce(new Error('poll interrupted'));
    vi.stubGlobal('fetch',fetch);await expect(runFirecrawlResearch(f.input)).rejects.toThrow('poll interrupted');
    await stopTask(f.db,f.task.active_run_id,'cancelled','User cancelled');
    fetch.mockResolvedValueOnce(response({status:'processing'})).mockResolvedValueOnce(response({success:true}));
    await cancelFirecrawlResearch(f.env,f.task.active_run_id);
    expect(fetch.mock.calls.at(-1)?.[1].method).toBe('DELETE');
  });
  it('reads old research notebooks without restoring an Agent loop', async () => {
    const f=await fixture();
    const old={...f.task,workspace_json:JSON.stringify({report:'Historical report',findings:[],unknowns:['Old gap']})};
    expect(await resultForTask(f.env,old)).toMatchObject({report:'Historical report',unknowns:['Old gap']});
  });
});
it('enforces the provider prompt limit without silently truncating the brief',()=>{
  expect(()=>researchPayload({...brief,context:'x'.repeat(10000)},100)).toThrow('10000-character');
});
it('omits the dialect URI rejected by Firecrawl while retaining the output schema', () => {
  const payload = researchPayload(brief, 100);
  expect(payload.schema).not.toHaveProperty('$schema');
  expect(payload.schema.required).toContain('findings');
  expect(payload.schema.additionalProperties).toBe(false);
});
it('sends a provider-compatible URL schema while retaining local URL and result validation', async () => {
  const f = await fixture();
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    if (init.method === 'POST') {
      const request = JSON.parse(String(init.body));
      const url = request.schema.properties.findings.items.properties.citations.items.properties.url;
      expect(url).toEqual({ type: 'string' });
      expect(request.schema.properties.findings.items.properties.citations.items.required).toContain('url');
      expect(request.schema.additionalProperties).toBe(false);
      expect(JSON.parse(request.prompt.split('Brief:\n')[1])).toMatchObject(brief);
      return response({ success: true, id: 'compatible-job' });
    }
    return response({ success: true, status: 'completed', data });
  });
  vi.stubGlobal('fetch', fetch);
  expect((await runFirecrawlResearch(f.input)).output.sources[0].url).toBe('https://example.com/product');
  for (const url of ['not a url', 'ftp://example.com/product']) {
    expect(() => normalizeResearch('task', { data: { ...data, findings: [{ ...data.findings[0],
      citations: [{ ...data.findings[0].citations[0], url }],
    }] } })).toThrow();
  }
});

it('reconciles an orphaned provider job after an intermediate parent closes without rewriting its failed task', async () => {
  const f = await fixture();
  const nestedRun = { ...f.createRun('nested-research', 'nested'), agent_id: 'deep_research' as const,
    parent_run_id: f.run.id, summary_json: JSON.stringify(brief) };
  await f.db.prepare('update agent_runs set agent_id=?,parent_run_id=?,summary_json=? where id=?')
    .bind(nestedRun.agent_id,nestedRun.parent_run_id,nestedRun.summary_json,nestedRun.id).run();
  const nested = await attachTask(f.db, nestedRun, agentDefinition('deep_research'));
  await f.db.prepare(`insert into firecrawl_research_jobs(task_id,root_task_id,status,job_id,request_json,reserved_credits,created_at,updated_at)
    values(?,?,'processing','orphan-job','{}',0,'old','old')`).bind(nested.id,f.parent.id).run();
  await stopTask(f.db,nested.active_run_id,'failed','Original child failure','failed',{ reason: 'Original child failure' });
  const before = await taskForRun(f.db,nested.active_run_id);
  const fetch = vi.fn().mockResolvedValueOnce(response({status:'processing'}))
    .mockRejectedValueOnce(new Error('Cancellation interrupted'))
    .mockResolvedValueOnce(response({status:'completed',data,creditsUsed:7}));
  vi.stubGlobal('fetch',fetch);
  // A failed child with an open parent is still eligible for explicit recovery.
  await reconcileFirecrawlCancellations(f.env);
  expect(fetch).not.toHaveBeenCalled();
  await stopTask(f.db,f.run.id,'completed','Intermediate parent finished');
  await reconcileFirecrawlCancellations(f.env);
  expect(fetch.mock.calls.map(call => call[1].method)).toEqual(['GET','DELETE']);
  await reconcileFirecrawlCancellations(f.env);
  await reconcileFirecrawlCancellations(f.env);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await taskForRun(f.db,nested.active_run_id)).toEqual(before);
  expect((await taskForRun(f.db,f.parent.active_run_id))?.status).toBe('running');
  const job = await f.db.prepare('select status,credits_used,raw_json from firecrawl_research_jobs where task_id=?').bind(nested.id).first<{status:string;credits_used:number;raw_json:string}>();
  expect(job).toMatchObject({status:'cancelled',credits_used:7});
  expect(JSON.parse(job!.raw_json)).toMatchObject({status:'completed',data});
});
it('keeps unsupported findings explicit instead of inventing citations',()=>{
  expect(normalizeResearch('task',{data:{...data,findings:[],outcome:'no_findings'}})).toMatchObject({outcome:'no_findings',sources:[]});
});

// @ts-ignore Node-only test environment.
const live = process.env.FIRECRAWL_RESEARCH_LIVE === '1';
it.skipIf(!live)('runs the actual provider adapter and durable task against Firecrawl', async () => {
  // @ts-ignore Node-only fixture I/O; never bundled into the Worker.
  const { readFileSync, writeFileSync } = await import('node:fs');
  const vars = readFileSync('.dev.vars','utf8');
  const key = vars.match(/^\s*FIRECRAWL_API_KEY\s*=\s*(.*?)\s*$/m)?.[1].replace(/^(['"])(.*)\1$/,'$2');
  expect(key).toBeTruthy();
  const f=await fixture();f.env.FIRECRAWL_API_KEY=key;
  await f.db.prepare('update agent_tasks set goal_json=? where id=?').bind(JSON.stringify({
    research_question:'Compare Language Reactor and Readlang for adults learning English through web reading and video subtitles. Use official product pages. Give a concise pt-BR comparison, short verbatim evidence, and clearly distinguish hypothetical Brazilian SEO opportunities from measured demand. Do not invent search volumes.',
    scope:'Small public product benchmark only. At most two products; no customer-private data.',locale:'pt-BR',
  }),f.task.id).run();
  const started=Date.now();
  const liveStep={...step,sleep:async()=>{
    if(Date.now()-started>180000) throw new Error('Live verification time limit reached');
    await new Promise(resolve=>setTimeout(resolve,15000));
  }} as unknown as RuntimeWorkflowStep;
  try {
    const result=await runFirecrawlResearch({...f.input,step:liveStep});
    const receipt=await f.db.prepare('select job_id,status,credits_used,raw_json,request_json from firecrawl_research_jobs where task_id=?').bind(f.task.id).first();
    writeFileSync('/tmp/firecrawl-integrated-verification.json',JSON.stringify({elapsed_ms:Date.now()-started,result,receipt},null,2));
    expect(result.output.outcome).toMatch(/completed|partial|no_findings|needs_input/);
    expect((await taskForRun(f.db,f.task.active_run_id))?.model_calls).toBe(0);
    expect(result.output.sources.every(source=>source.evidence_type==='provider_excerpt')).toBe(true);
    console.info('FIRECRAWL_INTEGRATED_RESULT',JSON.stringify({elapsed_ms:Date.now()-started,outcome:result.output.outcome,findings:result.output.findings.length,sources:result.output.sources.length}));
  } finally {
    const current=await taskForRun(f.db,f.task.active_run_id);
    if(current?.status!=='completed') {await stopTask(f.db,f.task.active_run_id,'cancelled','Live verification ended');await cancelFirecrawlResearch(f.env,f.task.active_run_id);}
  }
},240000);

it('delivers the hosted result through the strategy deep_research tool',async()=>{
  const f=await fixture();
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response({success:true,id:'job'})).mockResolvedValueOnce(response({status:'completed',data,creditsUsed:2})));
  await runFirecrawlResearch(f.input);
  const operation=await beginTaskDecision(f.db,f.parent,{});
  const definition=agentDefinition('strategy_research');
  const registry=strategyTaskTools({env:f.env,step,definition,runId:f.parent.active_run_id,task:f.parent,operation,locale:'pt-BR'});
  const tool=registry.resolve(definition,'deep_research');
  const output=await tool.execute!(tool.inputSchema.parse(brief),{runId:f.parent.active_run_id,workspaceId:f.parent.workspace_id,siteId:f.parent.site_id,idempotencyKey:operation.id});
  expect(output).toMatchObject({task_id:f.task.id,outcome:'partial',sources:[{evidence_type:'provider_excerpt'}]});
});

it('passes the strategy-authored brief and market intact to the provider', () => {
  const request = { ...brief, research_question: 'How do readers discover bilingual reading tools?', decision_use: 'Choose an acquisition territory', scope: 'Brazilian adult learners', deliverable: 'Evidence and explicit unknowns', context: 'Confirmed: browser reading tool. Unknown: market demand.', locale: 'pt-BR' };
  const payload = researchPayload(request, 100);
  const sentBrief = JSON.parse(payload.prompt.split('Brief:\n')[1]);
  expect(sentBrief).toMatchObject(request);
});
