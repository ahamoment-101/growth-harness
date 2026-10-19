import type { WorkProvider } from './contracts';
import { getTopicDecisionResult, publicTopicDecisionResult, approveTopicDecisionResult, rejectTopicDecisionResult } from '../agent-runtime/topic-decision-store';
import { startApprovedTopicGroup } from '../agent-runtime/topic-review-dispatch';

function evidenceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const evidence = value as Record<string, unknown>;
  return [evidence.title, evidence.summary, evidence.url, evidence.ref].filter(item => typeof item === 'string' && item).join(' · ');
}

export const topicWorkProvider: WorkProvider = {
  id: 'topic', agents: ['topic_decision'],
  async pending(scope, agentId) {
    const rows = await scope.db.prepare(`select t.id as task_id,r.id as result_id,r.group_goal,r.updated_at from topic_decision_results r
      join agent_tasks t on t.active_run_id=r.run_id and +t.workspace_id=r.workspace_id and +t.site_id=r.site_id
      where r.workspace_id=? and r.site_id=? and +t.agent_id=? and r.status='draft'
        and not exists(select 1 from agent_tasks p where p.id=t.parent_task_id and p.agent_id='growth_leader' and p.definition_version>=12
          and p.status not in ('completed','cancelled','failed'))`)
      .bind(scope.workspaceId, scope.siteId, agentId).all<{ task_id: string; result_id: string; group_goal: string; updated_at: string }>();
    return rows.results.map(row => ({ task_id: row.task_id, request_id: `topic:${row.result_id}`, label: row.group_goal || 'Topic plan awaiting confirmation', at: row.updated_at }));
  },
  async read({ db, workspaceId, siteId, task }) {
    const leaderOwned = !!await db.prepare(`select 1 from agent_tasks p where p.id=? and p.workspace_id=? and p.site_id=?
      and p.agent_id='growth_leader' and p.definition_version>=12 and p.status not in ('completed','cancelled','failed')`)
      .bind(task.parent_task_id, workspaceId, siteId).first();
    const rows = await db.prepare(`select id from topic_decision_results where +workspace_id=? and +site_id=? and run_id=? and decision_type='topic_group' order by created_at,id`)
      .bind(workspaceId, siteId, task.active_run_id).all<{ id: string }>();
    return Promise.all(rows.results.map(async row => {
      const result = (await publicTopicDecisionResult(db, workspaceId, siteId, row.id))!;
      const pending = result.status === 'draft';
      const markdown = [result.group_goal, result.rationale, result.group_hypothesis ? `Expected: ${result.group_hypothesis}` : '', ...result.items.map((item, index) =>
        `### ${index + 1}. ${item.title_direction}\n\n${item.rationale}\n\n${item.hypothesis ? `Expected: ${item.hypothesis}` : ''}\n\n${item.risk ? `Risks: ${item.risk}` : ''}\n\n${item.evidence.map(evidenceText).filter(Boolean).join('\n\n')}`),
        result.risks.length ? `### Risks

${result.risks.join('\n\n')}` : '',
        result.unknowns.length ? `### To Be Verified

${result.unknowns.join('\n\n')}` : '',
        result.web_evidence.length ? `### Research Basis

${result.web_evidence.map(evidenceText).filter(Boolean).join('\n\n')}` : '',
      ].filter(Boolean).join('\n\n');
      return { id: `topic:${result.id}`, at: result.created_at, title: pending ? leaderOwned ? 'Leader is reviewing the topic plan' : 'Your confirmation of the topic plan is needed' : result.status === 'rejected' ? leaderOwned ? 'Leader has submitted revision feedback' : 'You have rejected this set of topics' : leaderOwned ? 'Leader has approved the topic plan' : 'You have confirmed the topic plan',
        body: result.group_goal, state: pending ? leaderOwned ? 'working' as const : 'attention' as const : 'resolved' as const,
        materials: [{ title: `View topic plan · ${result.items.length} articles · ${result.scope.locale}`, markdown }],
        interaction: pending && leaderOwned ? undefined : { id: `topic:${result.id}`, version: result.updated_at, state: pending ? 'pending' as const : 'resolved' as const,
          fields: [{ id: 'note', label: 'Decision', kind: 'textarea' as const, max_length: 2000 }],
          actions: pending ? [
            { id: 'approve', label: 'Confirm and start content creation', tone: 'primary' as const, description: 'After confirmation, create the article Task for this group and hand it to the content creation agents.' },
            { id: 'reject', label: 'Reject', input_mode: 'popover' as const, required_fields: ['note'], description: 'Please explain the reason; the feedback will be kept as a reference for future topic selection.' },
          ] : [],
          response: pending ? undefined : { label: result.status === 'rejected' ? 'Rejected' : 'Confirmed', note: result.review_note, at: result.reviewed_at },
        } };
    }));
  },
  async respond(env, { workspaceId, siteId, task }, input, actorId) {
    const resultId = input.request_id.slice('topic:'.length);
    const result = await getTopicDecisionResult(env.DB, workspaceId, siteId, resultId) as Awaited<ReturnType<typeof getTopicDecisionResult>> & { review_operation_id?: string };
    if (!result || result.run_id !== task.active_run_id) throw new Error('The topic proposal does not belong to this Task');
    const replay = result.review_operation_id === input.command_id;
    if (!replay && (result.status !== 'draft' || result.updated_at !== input.version)) return { message: 'The proposal has been updated or already handled; this response was not applied. Please review the latest proposal.', outcome: 'superseded' };
    const common = { db: env.DB, workspaceId, siteId, resultId, actorId, note: input.values.note || '', expectedUpdatedAt: input.version, operationId: input.command_id };
    if (input.action === 'reject') {
      if (!replay) await rejectTopicDecisionResult(common);
      return { message: 'The rejection decision and reason have been recorded.' };
    }
    if (input.action !== 'approve') throw new Error('Unknown topic action');
    // These identities survive an interrupted response and dispatch, so approval never duplicates work.
    const productionGroupId = `work-group:${input.command_id}`;
    const parentRunId = `work-run:${input.command_id}`;
    if (!replay) await approveTopicDecisionResult({ ...common, productionGroupId, parentRunId });
    const started = await startApprovedTopicGroup(env, { workspaceId, siteId, resultId, productionGroupId, parentRunId });
    if (started.status === 'needs_attention') {
      return { message: 'The topic has been confirmed and kept; content creation has not started. Please tell the AI Growth Leader to continue with this group of content.' };
    }
    return { message: started.started ? 'The topic has been confirmed and handed to the content creation agents.' : 'The topic has been confirmed; the content creation Task was interrupted, please check the content creation Task.' };
  },
};
