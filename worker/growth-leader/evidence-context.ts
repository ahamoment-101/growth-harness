import type { RuntimeAgentEnv } from '../agent-runtime/env';
import type { AgentTask } from '../agent-runtime/task-store';
import { ToolContractError } from '../agent-runtime/tool-failure';

export const LEADER_EVIDENCE_INSTRUCTIONS = `Understand the purpose of information in the current work. User requests express goals; historical materials describe the past; read tools show business records at observation time; delegations express requirements and assumptions at that time; acceptance receipts only prove work was taken on; Task reports contain members' statements; the todo is your correctable working memory. This information does not become the outcome of new work in this session merely by appearing again. Reading time differs in meaning from creation, modification, and publication times, and being associated with the same object does not mean you created or modified it this time.

Before taking the next step, judge which key premises it depends on and their sources. Historical summaries, your own delegation backgrounds, todos, and members' restatements may repeat the same unverified claim; repetition is not independent evidence. When a key premise would change the action, verify it against current business records, outcomes, or explicit execution evidence, or delegate a specialist member to verify first and proceed accordingly. When reading lists, pay attention to scope and pagination; the number of production items does not represent the total number of topics, and not appearing in one list does not prove an object does not exist. Use read_workspace's topic_groups to view the topic groups' actual entries, review records, and associated work; target_ref points to a topic group, and only production_group_ref points to the associated production group; group_goal and requested_count express planning, while actual entries are governed by items; use content_groups to view production items and article to view specific articles. Do not conclude that remaining objects are actionable by subtracting the current list count from an old summary's count.

Allow the premises of an original delegation to be overturned. In delegations, distinguish observed facts, speculation, and conditions to be verified; state that the member is allowed to report actual conditions, limitations, and feasible paths when premises do not hold; request a report on what was actually done, references to outcomes produced or modified, and unresolved items. Do not write speculation as established fact to members. When continuing or reviewing, judge whether the evidence supports the current conclusion, and when necessary query, change plans, or adjust delegations. Existing articles can be used for summarizing, modification, reference, or avoiding duplication; whether they meet the goal depends on the user's request and actual work evidence. Ultimately state the business outcome or accurate progress directly to the user, without showing internal review processes.`;

export function leaderObservation(kind: string, source: string, data: unknown, observedAt = new Date().toISOString()) {
  return { observation: { kind, source, observed_at: observedAt,
    meaning: kind === 'task_report'
      ? 'Task lifecycle and member-reported output. Assignment is a request, including author assumptions; reported output is not independent proof of every claim or of completion of the current user goal.'
      : 'Read-only observation of existing site records. Observation time does not mean these objects were created or changed by the current task. Narrative summaries retain their original authorship; check underlying records when they determine the next action.',
  }, data };
}

/** Leader-only reader. Exposes recorded state, never infers eligibility or remaining work. */
export async function readLeaderTopics(env: RuntimeAgentEnv, task: AgentTask, target: string | undefined, offset: number) {
  const groupColumns = `r.id as target_ref,r.run_id,r.status,r.scope_locale,r.group_goal,${task.definition_version >= 12 && target ? 'r.rationale,r.group_hypothesis,r.expected_signals_json,r.risks_json,r.unknowns_json,r.web_evidence_json,' : ''}r.requested_count,r.reviewed_by,r.review_note,r.reviewed_at,r.created_at,r.updated_at,
    (select count(*) from topic_decision_items i where i.result_id=r.id) as actual_item_count,
    (select count(*) from topic_decision_items i where i.result_id=r.id and i.job_id is null) as items_without_job_reference,
    (select json_group_object(status,n) from (select j.status,count(*) n from topic_decision_items i join jobs j on j.id=i.job_id and j.site_id=r.site_id where i.result_id=r.id group by j.status)) as linked_items_by_job_status_json,
    (select p.id from content_production_groups p where p.decision_group_id=r.id and p.workspace_id=r.workspace_id and p.site_id=r.site_id) as production_group_ref`;
  if (!target) {
    const rows = (await env.DB.prepare(`select ${groupColumns} from topic_decision_results r where r.workspace_id=? and r.site_id=? order by r.created_at desc,r.id limit 51 offset ?`)
      .bind(task.workspace_id, task.site_id, offset).all()).results;
    return { groups: rows.slice(0, 50), next_offset: rows.length > 50 ? offset + 50 : null };
  }
  const group = await env.DB.prepare(`select ${groupColumns} from topic_decision_results r where r.workspace_id=? and r.site_id=? and r.id=?`)
    .bind(task.workspace_id, task.site_id, target).first();
  if (!group) throw new ToolContractError('Topic group not found in this site', { kind: 'invalid_request', effects: 'none', issues: [], guidance: 'Select an observed topic group reference in this site.' });
  const items = (await env.DB.prepare(`select i.id as topic_ref,i.title_direction,i.primary_keyword,i.locale,${task.definition_version >= 12 ? 'i.search_intent,i.group_role,i.rationale,i.hypothesis,i.evidence_json,i.relationship_to_existing,i.risk,' : ''}i.created_at,i.job_id,
    j.status as job_status,j.created_at as job_created_at,j.published_at,j.production_group_id
    from topic_decision_items i left join jobs j on j.id=i.job_id and j.site_id=?
    where i.result_id=? order by i.sort_order,i.id limit 51 offset ?`)
    .bind(task.site_id, target, offset).all()).results;
  return { group, items: items.slice(0, 50), next_offset: items.length > 50 ? offset + 50 : null };
}
