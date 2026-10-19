import { persistRuntimeJson, readRuntimeJson } from './runtime-content';
import { firecrawlRequest, FirecrawlRequestError, providerResearchSchema, researchPayload } from '../lib/research/firecrawl-agent';
import { researchResultSchema, resultForTask, type ResearchResult } from './research-contract';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { requireTask, taskForRun, stopTask, TaskPendingError, type AgentTask } from './task-store';
import { reserveExternalUsage } from './task-usage';
import { ExecutionHandoff } from './runtime-executions';
import { ExecutionFailureError, executionFailure } from './execution-failure';
import { BOOKKEEPING_STEP } from './runtime-limits';

type Job = { task_id: string; root_task_id: string; status: string; job_id: string; request_json: string; raw_json: string; reserved_credits: number; credits_used: number | null; error: string };
const readJob = (env: RuntimeAgentEnv, id: string) => env.DB.prepare('select * from firecrawl_research_jobs where task_id=?').bind(id).first<Job>();
const noRetry = { retries: { limit: 0, delay: '1 second' as const }, timeout: '1 minute' as const };
function budget(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Firecrawl credit limits must be positive integers');
  return number;
}
async function reserveJob(env: RuntimeAgentEnv, task: AgentTask): Promise<Job> {
  const existing = await readJob(env, task.id);
  if (existing) return existing;
  if (!env.FIRECRAWL_API_KEY) throw new Error('FIRECRAWL_API_KEY is not configured');
  const credits = budget(env.FIRECRAWL_RESEARCH_MAX_CREDITS);
  const request = researchPayload(JSON.parse(task.goal_json), credits, env.FIRECRAWL_RESEARCH_MODEL || 'spark-2');
  const now = new Date().toISOString();
  await env.DB.prepare(`insert or ignore into firecrawl_research_jobs(task_id,root_task_id,status,request_json,reserved_credits,created_at,updated_at)
    select t.id,t.root_task_id,'reserved',?,?,?,? from agent_tasks t join agent_tasks root on root.id=t.root_task_id
    where t.id=? and t.active_run_id=? and t.epoch=? and t.status='running' and root.status in ('running','waiting','paused')`)
    // Zero records no caller-specified cap; actual usage remains in credits_used.
    .bind(JSON.stringify(request),credits ?? 0,now,now,task.id,task.active_run_id,task.epoch).run();
  const saved = await readJob(env, task.id);
  if (!saved) { await requireTask(env.DB, task.active_run_id); throw new Error('Firecrawl job reservation lost task authority'); }
  return saved;
}

/** Provider excerpts are retained as provider output, never inserted as captured pages. */
export function normalizeResearch(taskId: string, raw: Record<string, unknown>): ResearchResult {
  const data = providerResearchSchema.parse(raw.data);
  const sources: ResearchResult['sources'] = [];
  const findings = data.findings.map((finding, index) => ({ id: `${taskId}:finding:${index + 1}`, claim: finding.claim, kind: finding.kind,
    evidence: finding.citations.map(c => {
      if (!/^https?:\/\//i.test(c.url)) throw new Error('Research citation must be an HTTP(S) URL');
      const id = `${taskId}:provider-source:${sources.length + 1}`;
      sources.push({ id, url: c.url, title: c.title, excerpt: c.quote, captured_at: new Date().toISOString(), evidence_type: 'provider_excerpt' });
      return { source_id: id, quote: c.quote, relation: c.relation };
    }) }));
  return researchResultSchema.parse({ task_id: taskId, ...data, findings, sources });
}

export async function cancelFirecrawlResearch(env: RuntimeAgentEnv, runId: string): Promise<void> {
  const task = await taskForRun(env.DB, runId);
  if (!task) return;
  const job = await readJob(env, task.id);
  if (!job || ['completed','failed','cancelled'].includes(job.status)) return;
  await env.DB.prepare("update firecrawl_research_jobs set status='cancel_requested',updated_at=? where task_id=? and status not in ('completed','failed','cancelled')")
    .bind(new Date().toISOString(),task.id).run();
  if (job.status === 'reserved') {
    await env.DB.prepare("update firecrawl_research_jobs set status='cancelled',credits_used=0 where task_id=? and status='cancel_requested' and job_id=''").bind(task.id).run();
    return;
  }
  if (!job.job_id) return; // An in-flight submit records its ID even after the task fence closes.
  try {
    const status = await firecrawlRequest(env.FIRECRAWL_API_KEY || '', 'GET', job.job_id);
    if (['completed','failed','cancelled'].includes(String(status.status))) {
      const used = typeof status.creditsUsed === 'number' && status.creditsUsed >= 0 ? status.creditsUsed : null;
      await env.DB.prepare("update firecrawl_research_jobs set status='cancelled',credits_used=?,raw_json=?,error='',updated_at=? where task_id=? and status='cancel_requested'")
        .bind(used,await persistRuntimeJson(env.DB, status),new Date().toISOString(),task.id).run();
    } else {
      await firecrawlRequest(env.FIRECRAWL_API_KEY || '', 'DELETE', job.job_id);
      // DELETE acknowledges a request, not a terminal job or final bill. The sweep polls again.
    }
  } catch (error) {
    await env.DB.prepare('update firecrawl_research_jobs set error=?,updated_at=? where task_id=?')
      .bind(`Provider cancellation pending: ${String(error).slice(0,1000)}`,new Date().toISOString(),task.id).run();
    throw error;
  }
}

export async function runFirecrawlResearch({ env, step, runId }: { env: RuntimeAgentEnv; step: RuntimeWorkflowStep; runId: string }) {
  let task = await taskForRun(env.DB, runId);
  if (!task) throw new Error('Research task missing');
  if (task.status !== 'running') return { output: await resultForTask(env, task), phase: task.status };
  try {
    await step.do('firecrawl-reserve', BOOKKEEPING_STEP, async () => { await reserveJob(env, await requireTask(env.DB, runId)); return task!.id; });
    let job: Job;
    // Always inspect current receipt: Workflow replay must not reuse a pre-submission snapshot.
    job = (await readJob(env, task.id))!;
    if (job.status === 'reserved') {
      await step.do('firecrawl-submit', noRetry, async () => {
        const current = await requireTask(env.DB, runId);
        const latest = (await readJob(env, current.id))!;
        if (latest.job_id) return;
        if (latest.status !== 'reserved') throw new TaskPendingError('Provider submission outcome is unknown; reconcile the original request before resubmitting');
        await reserveExternalUsage(env.DB, runId, 'firecrawl_agent');
        const claim = await env.DB.prepare(`update firecrawl_research_jobs set status='submitting',submission_execution_id=?,updated_at=? where task_id=? and status='reserved'
          and exists(select 1 from agent_tasks t join agent_tasks root on root.id=t.root_task_id where t.id=? and t.active_run_id=? and t.status='running' and root.status in ('running','waiting','paused'))`)
          .bind(env.execution?.executionId || '',new Date().toISOString(),current.id,current.id,runId).run();
        if (!claim.meta.changes) throw new TaskPendingError('Provider submission already claimed or task stopped');
        try {
          const response = await firecrawlRequest(env.FIRECRAWL_API_KEY!, 'POST', '', JSON.parse(latest.request_json));
          if (response.success !== true || typeof response.id !== 'string' || !response.id) throw new Error('Provider did not return a job ID; submission outcome unknown');
          // Save the external identity even if cancellation happened during the network request.
          if (env.recordFirecrawlIdentity) await env.recordFirecrawlIdentity(current.id, response.id);
          else await env.DB.prepare("update firecrawl_research_jobs set job_id=?,status=case when status='cancel_requested' then status else 'processing' end,updated_at=? where task_id=? and job_id=''")
            .bind(response.id,new Date().toISOString(),current.id).run();
        } catch (error) {
          const rejected = error instanceof FirecrawlRequestError && error.rejectedBeforeCreation;
          await env.DB.prepare("update firecrawl_research_jobs set status=?,credits_used=?,error=?,updated_at=? where task_id=? and job_id='' and status='submitting'")
            .bind(rejected ? 'failed' : 'unknown',rejected ? 0 : null,String(error).slice(0,2000),new Date().toISOString(),current.id).run();
          if (!rejected) throw new TaskPendingError('Firecrawl submission outcome unknown; no automatic resubmission. Inspect the provider account before recovery.');
        }
      });
      job = (await readJob(env, task.id))!;
    }
    if (['unknown','submitting'].includes(job.status)) throw new TaskPendingError('Firecrawl submission outcome unknown; reconcile it before resuming');
    for (let poll = 0; !['completed','failed','cancelled'].includes(job.status); poll++) {
      await requireTask(env.DB, runId);
      if (!job.job_id) throw new TaskPendingError('Provider job ID unavailable');
      await step.do(`firecrawl-poll-${poll}`, noRetry, async () => {
        await requireTask(env.DB, runId);
        await reserveExternalUsage(env.DB, runId, 'firecrawl_agent_status');
        const raw = await firecrawlRequest(env.FIRECRAWL_API_KEY!, 'GET', job.job_id);
        if (!['processing','completed','failed','cancelled'].includes(String(raw.status))) throw new Error('Unexpected Firecrawl job status; retained job can be queried again');
        const used = typeof raw.creditsUsed === 'number' && Number.isFinite(raw.creditsUsed) && raw.creditsUsed >= 0 ? raw.creditsUsed : null;
        await env.DB.prepare(`update firecrawl_research_jobs set status=?,raw_json=?,credits_used=?,error=?,updated_at=?
          where task_id=? and status='processing'`)
          .bind(raw.status,await persistRuntimeJson(env.DB, raw),['completed','failed','cancelled'].includes(String(raw.status)) ? used : null,
            String(raw.error || ''),new Date().toISOString(),task!.id).run();
      });
      job = (await readJob(env, task.id))!;
      if (job.status === 'processing') await step.sleep(`firecrawl-wait-${poll}`, '30 seconds');
    }
    await requireTask(env.DB, runId);
    const raw = await readRuntimeJson<Record<string, unknown>>(env.DB, job.raw_json);
    const partial = providerResearchSchema.safeParse(raw.data).success ? normalizeResearch(task.id,raw) : null;
    const validCompletion = job.status === 'completed' && Boolean(partial);
    const output = validCompletion ? partial! : researchResultSchema.parse({
      ...(partial || {}),task_id:task.id,outcome:job.status === 'cancelled' ? 'cancelled' : 'failed',summary:partial?.summary || '',report:partial?.report || '',findings:partial?.findings || [],sources:partial?.sources || [],unknowns:partial?.unknowns || [],reason:job.error || (job.status === 'completed' ? 'Provider returned an invalid research payload; original receipt retained' : 'Provider research failed') });
    const finished = await stopTask(env.DB,runId,validCompletion ? 'completed' : 'failed',output.reason,output.outcome,output);
    if (!finished) throw new Error('Research finalization lost execution ownership');
    return { output, phase: output.outcome };
  } catch (error) {
    if (error instanceof ExecutionHandoff) throw error;
    task = (await taskForRun(env.DB,runId))!;
    const root = await env.DB.prepare('select status from agent_tasks where id=?').bind(task.root_task_id).first<{status:string}>();
    if (task.status === 'cancelled' || root?.status === 'cancelled') {
      throw error;
    }
    if (!(error instanceof TaskPendingError)) throw new ExecutionFailureError(executionFailure(error, 'firecrawl') || { origin: 'upstream', scope: 'request', recovery_action: 'retry_request', message: String(error), status: 0, request_id: '', stage: 'firecrawl' });
    await stopTask(env.DB,runId,'paused',String(error),'external_pending');
    return { output: await resultForTask(env,(await taskForRun(env.DB,runId))!), phase: 'deferred' };
  }
}

/** Finish cancellation even when the child Workflow was terminated during submit/poll. Open statuses are listed so the per-minute scan seeks the status index instead of walking every finished job. */
export async function reconcileFirecrawlCancellations(env: RuntimeAgentEnv): Promise<void> {
  const rows = await env.DB.prepare(`select t.active_run_id from firecrawl_research_jobs j
    join agent_tasks t on t.id=j.task_id
    where (t.status='cancelled' or j.status='cancel_requested' or exists (
      with recursive ancestors(id,parent_task_id,status) as (
        select p.id,p.parent_task_id,p.status from agent_tasks p where p.id=t.parent_task_id
        union all select p.id,p.parent_task_id,p.status from agent_tasks p join ancestors a on p.id=a.parent_task_id
      ) select 1 from ancestors where status in ('completed','failed','cancelled')
    )) and j.status in ('reserved','submitting','processing','unknown','cancel_requested')
    order by j.updated_at limit 10`).all<{ active_run_id: string }>();
  for (const row of rows.results) {
    try { await cancelFirecrawlResearch(env,row.active_run_id); }
    catch (error) { console.warn('Firecrawl cancellation pending', String(error)); }
  }
}
