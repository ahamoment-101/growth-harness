import type { RuntimeAgentEnv } from './env';
import { getAgentRun } from './store';
import { startRuntimeRun } from './run-service';
import { contentGroupInstance } from './content-production';

/** Resume the content handoff created by a topic approval, including after an interrupted dispatch. */
export async function startApprovedTopicGroup(env: RuntimeAgentEnv, input: {
  workspaceId: string; siteId: string; resultId: string; productionGroupId: string; parentRunId: string;
}) {
  try {
    const existing = await getAgentRun(env.DB, input.parentRunId);
    if (!existing || existing.status === 'queued') await startRuntimeRun(env, {
      runId: input.parentRunId, workspaceId: input.workspaceId, siteId: input.siteId,
      agentId: 'content_production', instanceId: contentGroupInstance(input.productionGroupId), trigger: 'manual',
      summary: { group_id: input.productionGroupId, decision_group_id: input.resultId },
    });
  } catch (error) {
    await env.DB.prepare("update content_production_groups set status='needs_attention',error=?,updated_at=? where id=? and workspace_id=? and site_id=?")
      .bind(String(error).slice(0, 1000), new Date().toISOString(), input.productionGroupId, input.workspaceId, input.siteId).run();
    return { started: false, status: 'needs_attention' as const };
  }
  const started = await getAgentRun(env.DB, input.parentRunId);
  return { started: started?.status !== 'failed' && started?.status !== 'cancelled', status: started?.status || 'queued' };
}
