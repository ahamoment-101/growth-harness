import { z } from 'zod';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from '../agent-runtime/env';
import type { AgentTask, TaskOperation } from '../agent-runtime/task-store';
import { ToolRegistry } from '../agent-runtime/tools';
import { ToolContractError } from '../agent-runtime/tool-failure';
import { getTopicDecisionResult, publicTopicDecisionResult, approveTopicDecisionResult, rejectTopicDecisionResult } from '../agent-runtime/topic-decision-store';
import { dispatchChildTask } from '../agent-runtime/task-children';
import { topicInstance } from '../agent-runtime/topic-scope';
import { contentGroupInstance } from '../agent-runtime/content-production';
import { bindLearningDelegation, topicPractice } from '../learning/leader';

function conflict(message: string): never {
  throw new ToolContractError(message, { kind: 'state_conflict', effects: 'none', issues: [], guidance: 'Read the current topic group and choose an observed version.' });
}

/** Domain-local review authority for topic groups delegated by this Leader conversation. */
export function registerLeaderTopicReview(registry: ToolRegistry, env: RuntimeAgentEnv, step: RuntimeWorkflowStep, task: AgentTask, operation?: TaskOperation) {
  registry.register({
    name: 'review_topic_group', version: 1, capability: 'write', replaySafety: 'idempotent',
    executionMode: 'durable_call', timeoutMs: 60_000, retryable: false, approval: 'never', outputSchema: z.unknown(),
    description: 'Review an observed topic group from a directly delegated topic Agent. Approve creates the article jobs and starts content production. Revise records concrete feedback and delegates a new topic task because the submitted child Run is complete. First read the exact group and its items with read_workspace topic_groups; use its observed updated_at. Judge evidence and fit to the user goal yourself. A stale or unrelated group is rejected.',
    inputSchema: z.object({ group_ref: z.string().min(1), observed_updated_at: z.string().min(1),
      decision: z.enum(['approve', 'revise']), reason: z.string().trim().min(1).max(2000) }),
    execute: async args => {
      const op = operation!;
      const ownership = await env.DB.prepare(`select r.run_id from topic_decision_results r join agent_tasks child
        on child.active_run_id=r.run_id and child.workspace_id=r.workspace_id and child.site_id=r.site_id
        where r.id=? and r.workspace_id=? and r.site_id=? and r.decision_type='topic_group'
          and child.agent_id='topic_decision' and child.parent_task_id=?`)
        .bind(args.group_ref, task.workspace_id, task.site_id, task.id).first();
      if (!ownership) conflict('Topic group was not delegated by this Leader conversation');
      const result = await getTopicDecisionResult(env.DB, task.workspace_id, task.site_id, args.group_ref);
      if (!result) conflict('Topic group no longer exists');
      const replay = result.review_operation_id === op.id;
      if (replay && result.status !== (args.decision === 'approve' ? 'handed_off' : 'rejected')) conflict('This operation already made a different topic decision');
      if (!replay && (result.status !== 'draft' || result.updated_at !== args.observed_updated_at)) conflict('Topic group changed after observation');
      if (!result.scope_locale) conflict('Topic group has no language scope');
      const common = { db: env.DB, workspaceId: task.workspace_id, siteId: task.site_id,
        resultId: args.group_ref, actorId: 'growth_leader', note: args.reason,
        expectedUpdatedAt: args.observed_updated_at, operationId: op.id };
      const learning = await bindLearningDelegation(env, task, op, await topicPractice(env, task, args.group_ref));
      if (args.decision === 'approve') {
        const productionGroupId = `leader-topic-group:${op.id}`;
        const parentRunId = `child-${task.id}-${op.turn}`;
        if (!replay) await approveTopicDecisionResult({ ...common, productionGroupId, parentRunId });
        const assignment = { goal: 'Produce and review the approved topic group.', reason: args.reason,
          context: { approved_group_ref: args.group_ref, production_group_ref: productionGroupId,
            ...(learning ? { business_guidance: learning.guidance } : {}) } };
        const dispatched = await dispatchChildTask({ env, step, task, operation: op, agentId: 'content_production',
          instanceId: contentGroupInstance(productionGroupId),
          summary: { group_id: productionGroupId, decision_group_id: args.group_ref, delegation: assignment }, assignment });
        return { decision: 'approve', group_ref: args.group_ref, production_group_ref: productionGroupId,
          content_task_ref: dispatched.task.id, content_status: dispatched.task.status,
          result_delivery: 'this_conversation' };
      }
      if (!replay) await rejectTopicDecisionResult(common);
      const proposal = await publicTopicDecisionResult(env.DB, task.workspace_id, task.site_id, args.group_ref);
      if (!proposal) conflict('Reviewed topic group no longer exists');
      const assignment = { goal: 'Revise this topic proposal in response to the Leader review.',
        reason: args.reason, context: { previous_group_ref: args.group_ref, group_goal: proposal.group_goal,
          ...(learning ? { business_guidance: learning.guidance } : {}),
          rationale: proposal.rationale, items: proposal.items.map(item => ({ title_direction: item.title_direction,
            primary_keyword: item.primary_keyword, rationale: item.rationale, hypothesis: item.hypothesis,
            evidence: item.evidence, risk: item.risk })) } };
      const locale = result.scope_locale;
      const summary = { scope: { locale }, locales: [locale], group_size: Math.max(1, Math.min(20, proposal.items.length)),
        revision_of: args.group_ref, review_feedback: args.reason, delegation: assignment };
      const dispatched = await dispatchChildTask({ env, step, task, operation: op, agentId: 'topic_decision',
        instanceId: topicInstance({ locale }), summary, assignment });
      return { decision: 'revise', group_ref: args.group_ref, review_note: args.reason,
        revision_task_ref: dispatched.task.id, result_delivery: 'this_conversation' };
    },
  });
}
