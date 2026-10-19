import type { D1Database } from '@cloudflare/workers-types';
import { requireTask, TaskStateError } from './task-store';

// Charge every provider attempt, including failed/unknown requests. A replayed
// durable tool uses a new attempt ID unless its completed receipt is available.
export async function reserveExternalUsage(db: D1Database, runId: string, provider: string, units = 1): Promise<string> {
  const task = await requireTask(db, runId);
  const id = crypto.randomUUID();
  const result = await db.batch([
    db.prepare(`insert into agent_task_external_usage(id,task_id,provider,units,created_at)
      select ?,id,?,?,? from agent_tasks where id = ? and status = 'running' and active_run_id = ?
      and exists(select 1 from agent_tasks r where r.id = ? and r.status in ('running','waiting','paused'))`)
      .bind(id, provider, units, new Date().toISOString(), task.id, runId, task.root_task_id),
    db.prepare(`update agent_tasks set external_calls = external_calls + ? where id in (?,?)
      and exists(select 1 from agent_task_external_usage where id = ?)`)
      .bind(units, task.id, task.root_task_id, id),
  ]);
  if (!result[0].meta.changes) throw new TaskStateError('External request lost execution authority');
  return id;
}

export async function searchTaskWeb(env: import('./env').RuntimeAgentEnv, runId: string, queries: string[], signal?: AbortSignal, country?: string) {
  const { searchWeb } = await import('../lib/research/search');
  let receipt = '';
  return searchWeb({ apiKey: env.FIRECRAWL_API_KEY || '', queries, signal, country,
    beforeRequest: async () => { receipt = await reserveExternalUsage(env.DB, runId, 'firecrawl_search'); },
    onUsage: async (credits) => { await env.DB.prepare('update agent_task_external_usage set provider_credits = ? where id = ?').bind(credits, receipt).run(); },
  });
}
