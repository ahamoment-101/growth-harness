import type { TeamScope } from './signals';
import { pendingWork } from '../agent-work';

/** Acknowledge only the exact completed task version actually rendered by the panel. */
export async function markSeen({ db, workspaceId, siteId }: TeamScope, agentId: string, taskId: string, at: string): Promise<void> {
  await db.prepare(`insert or ignore into team_status_receipts (workspace_id, site_id, agent_id, task_id, completed_at)
    select workspace_id, site_id, agent_id, id, updated_at from agent_tasks
    where workspace_id=? and site_id=? and agent_id=? and id=? and updated_at=? and ((status='completed' and (outcome != 'unable_to_complete' or parent_task_id != ''))
        or (status='waiting' and parent_task_id != '' and outcome in ('submitted','reviewed')))`)
    .bind(workspaceId, siteId, agentId, taskId, at).run();
}

/** Acknowledge every currently unread history completion for one Agent, including older pages. */
export async function markAllHistorySeen(scope: TeamScope, agentId: string): Promise<void> {
  const { db, workspaceId, siteId } = scope;
  const pendingIds = [...new Set((await pendingWork(scope, agentId)).map(item => item.task_id))];
  await db.prepare(`insert or ignore into team_status_receipts (workspace_id, site_id, agent_id, task_id, completed_at)
    select t.workspace_id, t.site_id, t.agent_id, t.id, t.updated_at from agent_tasks t
    where t.workspace_id=? and t.site_id=? and t.agent_id=? and t.status='completed'
      and (t.outcome != 'unable_to_complete' or t.parent_task_id != '')
      and t.id not in (select value from json_each(?))`)
    .bind(workspaceId, siteId, agentId, JSON.stringify(pendingIds)).run();
}
