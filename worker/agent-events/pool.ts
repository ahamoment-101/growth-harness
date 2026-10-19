import type { D1Database } from '@cloudflare/workers-types';
import type { RuntimeAgentEnv } from '../agent-runtime/env';

export const ARTICLE_REVIEW_TYPE = 'content.article_ready_for_publication_review';
export const ARTICLE_PUBLISHED_TYPE = 'content.article_published';
export const TASK_REPORT_TYPE = 'agent.task_report_ready';
export const publicationConversationId = (siteId: string) => `publication:${siteId}`;
const PAGE_SIZE = 20;

export type EventDelivery = {
  event_id: string;
  type: string;
  subject_id: string;
  subject_version: string;
  source_ref: string;
  summary: string;
  available_at: string;
  status: string;
  target_run_id: string;
};

export async function pendingEventDeliveries(db: D1Database, scope: { workspaceId: string; siteId: string; agentId: string }, runId: string, limit = PAGE_SIZE) {
  const target = runId === publicationConversationId(scope.siteId) ? '' : runId;
  const due = new Date().toISOString();
  const pages = await Promise.all([...new Set([target, runId])].flatMap(recipient => ['pending','delivered'].map(async status =>
    (await db.prepare(`select d.event_id,e.type,e.subject_id,e.subject_version,e.source_ref,e.summary,
      d.available_at,d.status,d.target_run_id from agent_event_deliveries d
      join agent_pool_events e on e.id=d.event_id
      where d.target_run_id=? and d.status=? and d.available_at<=?
        and d.workspace_id=? and d.site_id=? and d.agent_id=?
      order by d.available_at,d.event_id limit ?`)
      .bind(recipient,status,due,scope.workspaceId,scope.siteId,scope.agentId,limit).all<EventDelivery>()).results)));
  return pages.flat().sort((a,b) => a.available_at.localeCompare(b.available_at) || a.event_id.localeCompare(b.event_id)).slice(0,limit);
}

export async function readAgentInbox(db: D1Database, scope: { workspaceId: string; siteId: string; agentId: string }, runId: string, limit = PAGE_SIZE) {
  const target = runId === publicationConversationId(scope.siteId) ? '' : runId;
  const queries = [...new Set([target,runId])].flatMap(recipient => ['pending','delivered','waiting'].map(status => ({recipient,status})));
  const pages = await Promise.all(queries.map(async ({recipient,status}) =>
    (await db.prepare(`select d.event_id,e.type,e.subject_id,e.subject_version,e.source_ref,e.summary,
      d.available_at,d.status,d.target_run_id from agent_event_deliveries d
      join agent_pool_events e on e.id=d.event_id
      where d.target_run_id=? and d.status=? and d.available_at<=?
        and d.workspace_id=? and d.site_id=? and d.agent_id=?
      order by d.available_at,d.event_id limit ?`)
      .bind(recipient,status,status==='pending'?new Date().toISOString():'9999-12-31',scope.workspaceId,scope.siteId,scope.agentId,limit)
      .all<EventDelivery>()).results));
  return pages.flat().sort((a,b) => a.available_at.localeCompare(b.available_at) || a.event_id.localeCompare(b.event_id)).slice(0,limit);
}

/** A bounded, indexed dispatch pass. The same function handles post-checkpoint and daily wakeups. */
export async function dispatchPendingAgentEvents(env: RuntimeAgentEnv, limit = 100) {
  type Due = { event_id: string; agent_id: string; workspace_id: string; site_id: string; target_run_id: string; available_at: string };
  const due = new Date().toISOString();
  const pages = await Promise.all(['pending','delivered'].map(async status =>
    (await env.DB.prepare(`select event_id,agent_id,workspace_id,site_id,target_run_id,available_at
      from agent_event_deliveries where status=? and available_at<=?
      order by available_at,event_id,agent_id limit ?`)
      .bind(status,due,limit).all<Due>()).results));
  const rows = pages.flat().sort((a,b) => a.available_at.localeCompare(b.available_at) || a.event_id.localeCompare(b.event_id)).slice(0,limit);
  if (!rows.length) return { pending: 0, woken: 0 };
  const { runtimeAgentModule } = await import('../agent-runtime/agent-modules');
  const { isAgentId } = await import('../agent-runtime/definitions');
  const targets = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (!isAgentId(row.agent_id)) continue;
    targets.set(`${row.workspace_id}:${row.site_id}:${row.agent_id}:${row.target_run_id}`, row);
  }
  let woken = 0;
  for (const target of targets.values()) {
    try {
      if (!isAgentId(target.agent_id)) continue;
      const wake = runtimeAgentModule(target.agent_id).wakeForEvent;
      if (!wake) continue;
      await wake(env, { workspaceId: target.workspace_id, siteId: target.site_id, targetRunId: target.target_run_id });
      woken++;
    } catch (error) { console.error('Agent event dispatch pending', target.event_id, String(error)); }
  }
  return { pending: rows.length, woken };
}
