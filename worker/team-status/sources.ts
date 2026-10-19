import type { AgentId } from '../agent-runtime/definitions';
import type { BubbleReason } from '../../shared/team-status';
import type { SignalSource, TeamScope, TeamSignal } from './signals';
import { taskSignals, type TaskFact } from './task-rules';

/**
 * Team status reads raw facts, then derives signals purely. The polled HTTP view and the live
 * SiteRoom projection (worker/site-room) share both halves, so they cannot drift apart.
 */
export type WorkRequestFact = { task_id: string; agent_id: string; count: number; at: string };
export type QueueFact = { count: number; at: string };
export type TeamFacts = { tasks: TaskFact[]; requests: WorkRequestFact[]; articles: QueueFact; topics: QueueFact };

// With ids, the list drives the join so each id is one primary-key seek; filtering a site's tasks by
// `t.id in (...)` instead makes SQLite walk every task of the site (cost grows with history).
const ids = (taskIds?: readonly string[]) => taskIds
  ? { tasks: 'json_each(?3) ids cross join agent_tasks t on t.id=ids.value', bind: [JSON.stringify(taskIds)] }
  : { tasks: 'agent_tasks t', bind: [] };

/** Unresolved work and unread completions survive newer work. Optional ids narrow the read to those tasks. */
export async function teamTaskFacts({ db, workspaceId, siteId }: TeamScope, taskIds?: readonly string[]): Promise<TaskFact[]> {
  const only = ids(taskIds);
  const { results } = await db.prepare(`
    select t.id, t.agent_id, t.status, t.outcome, t.parent_task_id,
      coalesce(p.agent_id, '') as parent_agent_id, t.updated_at,
      exists (select 1 from team_status_receipts s where s.workspace_id=t.workspace_id and s.site_id=t.site_id
        and s.agent_id=t.agent_id and s.task_id=t.id and s.completed_at=t.updated_at) as seen
    from ${only.tasks}
    left join agent_tasks p on p.id = t.parent_task_id and p.workspace_id = t.workspace_id and p.site_id = t.site_id
    where t.workspace_id = ?1 and t.site_id = ?2 and t.status != 'cancelled'
      and not (t.status = 'completed' and (t.outcome != 'unable_to_complete' or t.parent_task_id != '') and exists (
        select 1 from team_status_receipts s where s.workspace_id=t.workspace_id and s.site_id=t.site_id
          and s.agent_id=t.agent_id and s.task_id=t.id and s.completed_at=t.updated_at))`)
    .bind(workspaceId, siteId, ...only.bind).all<TaskFact>();
  return results;
}

/** Every durable request participates in attention without Agent-specific queries. */
export async function workRequestFacts({ db, workspaceId, siteId }: TeamScope, taskIds?: readonly string[]): Promise<WorkRequestFact[]> {
  const only = ids(taskIds);
  const { results } = await db.prepare(`select t.id as task_id,t.agent_id,count(*) as count,max(r.created_at) as at
    from ${only.tasks} join agent_work_requests r on r.task_id=t.id
    where t.workspace_id=?1 and t.site_id=?2 and t.status!='cancelled' and r.state='pending'
    group by t.id,t.agent_id`).bind(workspaceId, siteId, ...only.bind).all<WorkRequestFact>();
  return results;
}

/** Business items that wait for a person. */
export async function articleQueueFact({ db, siteId }: TeamScope): Promise<QueueFact> {
  const row = await db.prepare(`select count(*) as count, max(updated_at) as at from jobs where site_id = ? and status = 'awaiting_review'`).bind(siteId).first<{ count: number; at: string | null }>();
  return { count: Number(row?.count ?? 0), at: row?.at ?? '' };
}
export async function topicQueueFact({ db, workspaceId, siteId }: TeamScope): Promise<QueueFact> {
  const row = await db.prepare(`select count(*) as count, max(updated_at) as at from topic_decision_results
    where workspace_id = ? and site_id = ? and status = 'draft'`).bind(workspaceId, siteId).first<{ count: number; at: string | null }>();
  return { count: Number(row?.count ?? 0), at: row?.at ?? '' };
}

export async function readTeamFacts(scope: TeamScope): Promise<TeamFacts> {
  const [tasks, requests, articles, topics] = await Promise.all([teamTaskFacts(scope), workRequestFacts(scope), articleQueueFact(scope), topicQueueFact(scope)]);
  return { tasks, requests, articles, topics };
}

function queueSignal(agentId: AgentId, reason: BubbleReason, fact: QueueFact): TeamSignal[] {
  return fact.count ? [{ agent_id: agentId, kind: 'needs_you', reason, count: fact.count, peer_agent_id: '', at: fact.at }] : [];
}
function requestSignals(requests: readonly WorkRequestFact[]): TeamSignal[] {
  return requests.map(row => ({ ...row, kind: 'needs_you', reason: 'work_request', peer_agent_id: '' }));
}
/** Tasks that wait on a durable request show that request instead of their own lifecycle signal. */
function runtimeSignals(tasks: readonly TaskFact[], requests: readonly WorkRequestFact[]): TeamSignal[] {
  const waiting = new Set<string | undefined>(requests.map(item => item.task_id));
  return [...taskSignals(tasks).filter(item => !waiting.has(item.task_id)), ...requestSignals(requests)];
}
export function teamSignals(facts: TeamFacts): TeamSignal[] {
  return [...runtimeSignals(facts.tasks, facts.requests),
    ...queueSignal('content_production', 'review_articles', facts.articles),
    ...queueSignal('topic_decision', 'confirm_topic_group', facts.topics)];
}

export const runtimeTasks: SignalSource = async (scope) => runtimeSignals(await teamTaskFacts(scope), await workRequestFacts(scope));
export const articlesAwaitingReview: SignalSource = async (scope) => queueSignal('content_production', 'review_articles', await articleQueueFact(scope));
export const topicGroupsAwaitingConfirmation: SignalSource = async (scope) => queueSignal('topic_decision', 'confirm_topic_group', await topicQueueFact(scope));
export const SIGNAL_SOURCES: readonly SignalSource[] = [runtimeTasks, articlesAwaitingReview, topicGroupsAwaitingConfirmation];
