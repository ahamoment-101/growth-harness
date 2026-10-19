import type { D1Database } from '@cloudflare/workers-types';

/** Leader is internal to the classroom roster, but its visible conversations may collect HITL responses. */
export async function isLeaderConversationResponseRoute(db: D1Database, input: {
  workspaceId: string;
  siteId: string;
  agentId: string;
  taskId: string;
  method: string;
  responseAction: string | undefined;
}): Promise<boolean> {
  if (input.agentId !== 'growth_leader' || input.method !== 'POST' || input.responseAction !== '/responses' || !input.taskId) return false;
  let taskId: string;
  try { taskId = decodeURIComponent(input.taskId); }
  catch { return false; }
  const conversation = await db.prepare('select 1 from leader_conversations where id=? and workspace_id=? and site_id=?')
    .bind(taskId, input.workspaceId, input.siteId).first();
  return Boolean(conversation);
}
