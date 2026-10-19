import type { RuntimeAgentEnv } from './env';
import { contentGroupInstance } from './content-production';
import { startRuntimeRun } from './run-service';
import { getActiveAgentRun } from './store';
import { taskForRun } from './task-store';

/** A publication revision changes the group's business state, not its active management identity. */
export async function continueContentRevision(env: RuntimeAgentEnv, input: {
  workspaceId: string; siteId: string; groupId: string; decisionGroupId?: string | null; jobId: string;
}) {
  const instanceId = contentGroupInstance(input.groupId);
  const existing = await getActiveAgentRun(env.DB, input.workspaceId, input.siteId, 'content_production', instanceId);
  if (existing) {
    const task = await taskForRun(env.DB, existing.id);
    if (task && ['waiting', 'paused', 'failed'].includes(task.status)) {
      return startRuntimeRun(env, {
        workspaceId: input.workspaceId, siteId: input.siteId, agentId: 'content_production', instanceId,
        trigger: 'retry', retryOfRunId: existing.id,
      });
    }
    return existing;
  }
  return startRuntimeRun(env, {
    workspaceId: input.workspaceId, siteId: input.siteId, agentId: 'content_production', instanceId, trigger: 'manual',
    summary: { group_id: input.groupId, decision_group_id: input.decisionGroupId, human_revision_job_id: input.jobId },
  });
}
