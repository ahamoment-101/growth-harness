import { taskSubjectsJson, type TaskSubject } from './task-subjects';
import { runBusinessConversationTask } from '../learning/business';
import { z } from 'zod';
import { editorialError, type CoveragePlan, type EditorialCandidate } from './content-editorial';
import { readRuntimeJson } from './runtime-content';
import { persistRuntimeJson } from './runtime-content';
import type { AgentModuleExecutionContext } from './agent-modules';
import { createContentProductionToolRegistry, LEGACY_START_ARTICLE_TASKS_DESCRIPTION } from './content-production-tools';
import { claimContentProductionGroup, inspectContentProductionGroup, loadContentProductionContext, loadArticleProductionContext, loadContentReviewContext,
  contentReviewBody, finalizeContentGroup, markContentGroupAttention, type ContentGroupInspection, type ContentReviewVersion } from './content-production';
import { getSiteForWorkspace } from '../db';
import { saveSlot, resolveSlot, bindOperation } from './parameter-slots';
import { requireTask, taskForRun, taskDataJson, type AgentTask, type TaskOperation } from './task-store';
import { taskCommandRunId } from './task-commands';
import { getAgentRun } from './store';
import { currentExecution, createRuntimeExecution, dispatchExecution, ExecutionHandoff } from './runtime-executions';
import { waitForChildRuns } from './child-run-wait';
import { authorContentLinkContext, contentLinkPolicy, validateContentLinkLimit,
  PARENT_AUTHOR_LINK_REQUIREMENTS_INSTRUCTIONS, PARENT_INTERNAL_LINK_INSTRUCTIONS } from './content-link-policy';
import { ToolContractError } from './tool-failure';

export const CONTENT_DELEGATION_INSTRUCTIONS = 'Carry the business delegation through your work. When reporting back, explain what the observed results mean for that delegation, including any discrepancy between the requested work and the actual state, what you did, and anything still unresolved. Distinguish work performed for this assignment from pre-existing artifacts and historical reviews; interpret past recommendations against the current observed state. Published articles are immutable in this business workflow: do not reopen, edit, relink or republish them, and do not request a human choice of maintenance path. The delegation describes an intended goal and may contain mistaken assumptions: use observed facts to assess whether this scope can serve that goal. You may question an inapplicable assignment or recommend a different next step. Use judgment_summary to communicate your business assessment to the delegating Agent; closing group management does not by itself establish that the requested goal was fulfilled.';

export const CONTENT_COMPLETION_DESCRIPTION = 'Close management of the observed content group and deliver your business assessment to the delegating Agent. Every article must have reached publication review, publishing, or publication; unresolved drafting, failures or revisions prevent closure. In judgment_summary, explain what happened during this assignment, what already existed, how this relates to the delegation, and what remains unresolved. Closure does not perform publication or establish that the requested business goal was achieved.';

export const contentAssignmentSelection = z.object({ observation_ref: z.string().min(1), job_ids: z.array(z.string().min(1)).min(1).max(20), judgment_summary: z.string() });
export const contentEditorialWritingSelection = contentAssignmentSelection.extend({ editorial_brief: z.string(), coverage_plans: z.array(z.object({ job_id: z.string().min(1), coverage_ref: z.string().min(1) })) });
type ChildBinding = { jobId: string; runId: string; assignmentId: string; instanceId: string; summary: Record<string, unknown>; material: unknown; subjects?: TaskSubject[]; existing: boolean };

export async function runContentParentConversation(input: AgentModuleExecutionContext) {
  const { env, run, definition } = input;
  const editorial = run.definition_version >= 18;
  const linking = run.definition_version >= 19;
  // From v20 authors own internal links and reviewers check them; the parent neither reads drafts nor edits links.
  const authorLinks = run.definition_version >= 20;
  const conversationDefinition = linking && !authorLinks ? definition : { ...definition,
    tools: definition.tools.filter(name => !['read_content_article', 'read_published_articles', 'edit_article_internal_links'].includes(name)),
  };
  const groupId = String(JSON.parse(run.summary_json).group_id || '');
  await claimContentProductionGroup(env.DB, run.workspace_id, run.site_id, groupId, run.id);
  const inspect = async (task: AgentTask) => {
    const state = await inspectContentProductionGroup(env.DB, task.workspace_id, task.site_id, groupId, run.definition_version >= 22);
    const plans = editorial ? (await env.DB.prepare("select ref,value_json from agent_parameter_slots where task_id=? and kind='content_coverage'").bind(task.id).all<{ ref: string; value_json: string }>()).results : [];
    const coverage_plans = await Promise.all(plans.map(async p => ({ coverage_ref: p.ref, plan: await readRuntimeJson(env.DB, p.value_json) })));
    return { ...state, ...(editorial ? { coverage_plans } : {}), observation_ref: await saveSlot(env.DB, task, 'content_group', state) };
  };
  const selection = contentAssignmentSelection;
  const writingSelection = editorial ? contentEditorialWritingSelection : selection.extend({ editorial_brief: z.string() });
  const dispatch = async (task: AgentTask, operation: TaskOperation, raw: unknown, review: boolean) => {
    const args = (review ? selection : writingSelection).parse(raw) as z.infer<typeof selection> & { editorial_brief?: string; coverage_plans?: Array<{ job_id: string; coverage_ref: string }> };
    if (editorial && !review && (args.coverage_plans?.length !== args.job_ids.length || new Set(args.coverage_plans.map(p => p.job_id)).size !== args.job_ids.length || args.coverage_plans.some(p => !args.job_ids.includes(p.job_id)))) editorialError('coverage_plans', 'Select exactly one saved plan for each selected job');
    const bindings = await bindOperation(env.DB, task, operation, args, async () => {
      const observed = await resolveSlot<ContentGroupInspection>(env.DB, task, args.observation_ref, 'content_group');
      const site = await getSiteForWorkspace(env.DB, task.workspace_id, task.site_id);
      if (!site) throw new Error('Content site is missing');
      const children: ChildBinding[] = [];
      for (const jobId of [...new Set(args.job_ids)]) {
        const item = observed.items.find(item => item.job_id === jobId);
        if (!item) throw new Error(`Job ${jobId} was not in the observed content group`);
        const current = await env.DB.prepare('select status from jobs where id=? and site_id=? and production_group_id=?')
          .bind(jobId, task.site_id, groupId).first<{ status: string }>();
        if (!current || current.status !== item.job_status) throw new ToolContractError(`Job ${jobId} changed after the group observation`, {
          kind: 'state_conflict', effects: 'none', issues: [{ path: ['job_ids'], message: `Job ${jobId} must be observed again` }],
          guidance: 'Inspect the current content group before selecting this job.',
        });
        if (['awaiting_review','publishing','published'].includes(current.status)) throw new ToolContractError(
          current.status === 'published' ? `Job ${jobId} is published and cannot be modified` : `Job ${jobId} has already reached publication review`, {
            kind: 'state_conflict', effects: 'none', issues: [{ path: ['job_ids'], message: `Job ${jobId} is ${current.status}` }],
            guidance: current.status === 'published'
              ? 'Published articles are immutable in this business workflow. Report the boundary to the delegating Agent; no user choice can enable an edit through this tool.'
              : 'Inspect the current content state and choose an action available for this job.',
          });
        if (review ? item.artifact_status !== 'candidate' : item.artifact_status === 'candidate') throw new Error(`Job ${jobId} is not ready for this action; inspect its current candidate`);
        const childId = await taskCommandRunId(`${task.id}:${review ? 'review' : 'article'}:${jobId}`);
        const previous = await getAgentRun(env.DB, childId);
        const previousTask = previous ? await taskForRun(env.DB, childId) : null;
        if (previousTask && previousTask.status !== 'waiting') throw new Error(`Child ${childId} is not waiting for another assignment`);
        const summary = { group_id: groupId, job_id: jobId, attempt: review ? item.attempt : item.attempt + 1,
          ...(review ? { artifact_id: item.artifact_id } : { editorial_brief: args.editorial_brief || '', parent_feedback: item.parent_review.required_changes || [item.review_note] }) };
        const provisional = { ...run, id: childId, parent_run_id: run.id, agent_id: review ? 'content_review' : 'article_production',
          agent_instance_id: item.decision_item_id, summary_json: taskDataJson(summary) };
        const sources = await (review ? loadContentReviewContext : loadArticleProductionContext)(env.DB, site, provisional);
        const material = sources[0].value as Record<string, unknown>;
        if (linking) {
          material.internal_linking_contract = 1;
          if (review) validateContentLinkLimit(
            (material.versions as ContentReviewVersion[]).map(v => ({ locale: v.locale, content: contentReviewBody(v) })),
            contentLinkPolicy(site as unknown as Record<string, unknown>),
          );
        }
        if (!review) {
          if (authorLinks) material.author_link_contract = 1;
          material.editorial_contract_version = editorial ? 2 : 1;
          if (editorial) {
            const planRef = args.coverage_plans!.find(p => p.job_id === jobId)!.coverage_ref;
            const plan = await resolveSlot<CoveragePlan>(env.DB, task, planRef, 'content_coverage');
            if (plan.job_id !== jobId) editorialError('coverage_ref', 'Selected plan belongs to another job');
            material.coverage_plan = plan;
            if (item.artifact_id) {
              const old = await env.DB.prepare('select seo_contract_json,parent_review_json from content_artifacts where id=? and job_id=? and group_id=?')
                .bind(item.artifact_id, jobId, groupId).first<{ seo_contract_json: string; parent_review_json: string }>();
              if (old) {
                material.previous_editorial = (await readRuntimeJson<{ editorial?: EditorialCandidate }>(env.DB, old.seo_contract_json)).editorial;
                material.editorial_feedback = await readRuntimeJson(env.DB, old.parent_review_json);
              }
            }
          }
        }
        if (!review && material.previous_artifact_id !== item.artifact_id) throw new Error('Candidate changed after the group observation; inspect again');
        children.push({ jobId, runId: childId, assignmentId: previous ? `${operation.id}:${jobId}` : `${childId}:initial`, instanceId: item.decision_item_id, summary, material, subjects: [{ type: 'job', id: jobId, version: review ? item.artifact_id : null }], existing: Boolean(previous) });
      }
      return children;
    });
    const results: unknown[] = [];
    const concurrency = definition.runPolicy.maxActiveChildren || 20;
    for (let offset = 0; offset < bindings.length; offset += concurrency) {
      const batch = bindings.slice(offset, offset + concurrency);
      // Dispatches are individually durable. One failure does not discard siblings.
      const started: ChildBinding[] = [];
      for (const child of batch) {
        try {
          await requireTask(env.DB, task.active_run_id);
          if (!child.existing) {
            await input.startChildRun({ runId: child.runId, workspaceId: task.workspace_id, siteId: task.site_id,
              agentId: review ? 'content_review' : 'article_production', instanceId: child.instanceId, trigger: 'sub_agent', parentRunId: run.id, summary: child.summary, initialAssignment: { id: child.assignmentId, material: child.material, subjects: child.subjects } });
          } else {
            const childTask = (await taskForRun(env.DB, child.runId))!;
            if (childTask.assignment_id !== child.assignmentId) {
              const at = new Date().toISOString();
              await env.DB.batch([
                env.DB.prepare(`insert or ignore into agent_task_assignments(id,task_id,operation_id,context_json,created_at,subjects_json)
                  select ?,?,?,?,?,? where exists(select 1 from agent_tasks where id=? and parent_task_id=? and status='waiting' and epoch=?)`)
                  .bind(child.assignmentId, childTask.id, child.assignmentId, await persistRuntimeJson(env.DB, child.material), at, taskSubjectsJson(child.subjects), childTask.id, task.id, childTask.epoch),
                env.DB.prepare(`update agent_tasks set assignment_id=? where id=? and parent_task_id=? and status='waiting' and epoch=?
                  and exists(select 1 from agent_task_assignments where id=?)`).bind(child.assignmentId, childTask.id, task.id, childTask.epoch, child.assignmentId),
                env.DB.prepare(`insert or ignore into agent_task_inputs(id,task_id,actor_id,content,created_at)
                  select ?,?,?,?,? where exists(select 1 from agent_tasks where id=? and assignment_id=?)`)
                  .bind(child.assignmentId, childTask.id, definition.id, taskDataJson({ assignment_id: child.assignmentId, instruction: 'Use the separately appended, persisted assignment material for this revision.' }), at, childTask.id, child.assignmentId),
              ]);
            }
            const assigned = (await taskForRun(env.DB, child.runId))!;
            if (assigned.assignment_id !== child.assignmentId) throw new Error('Child assignment lost its observed execution gate');
            const delivered = await env.DB.prepare('select 1 from agent_task_checkpoints where task_id=? and assignment_id=?').bind(assigned.id, child.assignmentId).first();
            if (assigned.status === 'waiting' && !delivered) {
              const previous = await currentExecution(env.DB, child.runId);
              const next = await createRuntimeExecution(env.DB, child.runId, previous!, 'parent_assignment');
              await dispatchExecution(env, next);
            }
          }
          if (!review) await env.DB.prepare("update jobs set child_run_id=?,status='drafting',updated_at=? where id=? and production_group_id=? and status not in ('publishing','published')")
            .bind(child.runId, new Date().toISOString(), child.jobId, groupId).run();
          started.push(child);
        } catch (error) { if (error instanceof ExecutionHandoff) throw error; results.push({ job_id: child.jobId, run_id: child.runId, status: 'dispatch_failed', error: String(error), effects: 'preserved' }); }
      }
      if (started.length) {
        const statuses = await waitForChildRuns({ env, step: input.step, stepKey: `children:${operation.id}:${offset}`,
          runIds: started.map(child => child.runId), assignments: Object.fromEntries(started.map(child => [child.runId, child.assignmentId])) });
        results.push(...statuses.map(state => ({ ...state, output: JSON.parse(state.outputJson) })));
      }
    }
    return { child_results: results, state: await inspect(task) };
  };
  const result = await runBusinessConversationTask({ env, step: input.step, runId: run.id, definition: conversationDefinition, agent: {
    auditCompletionTools: ['complete_content_group'],
    instructions: `${definition.mission}${authorLinks ? `\n${PARENT_AUTHOR_LINK_REQUIREMENTS_INSTRUCTIONS}` : linking ? `\n${PARENT_INTERNAL_LINK_INSTRUCTIONS}` : ''}${editorial ? '\nBefore writing, save_coverage_plan for each job and select its coverage_ref in coverage_plans. The saved plan travels with the assignment. Inspect returned coverage_findings and evidence_findings; revise the plan when author evidence justifies a changed page boundary. Priorities are editorial judgments, never quotas. Keep observed search facts separate from hypotheses.' : ''}\nManage the content group through semantic tools. Inspect the group and select job IDs using its observation_ref. Provide editorial_brief with specific writing guidance or targeted revision instructions. Plan pages that satisfy concrete search needs, not merely broad topical essays. In each editorial_brief, explain the primary reader intent and target market, useful subordinate questions or scenarios, the page's distinct contribution and boundaries relative to sibling and published articles, and a relevant product connection supported by business facts. Distinguish observed search evidence from hypotheses; if evidence is missing, ask the author to investigate with available tools rather than invent SERP findings or search volume. Let evidence and reader needs determine which questions belong on this page versus separate pages. Ask authors to make the main answer visible early and support consequential factual claims with attributable evidence. Do not prescribe keyword repetition, template counts, mandatory FAQs or a universal outline. Use the complete official product name from confirmed business facts every time you name a product, including headings, examples, localized versions and calls to action. Never shorten it, invent an abbreviation or translate the name without an explicitly approved official localized full name. Preserve verified product capability boundaries; do not imply unsupported capabilities or outcomes. Delegate writing and independent review; children retain isolated continuous conversations, and return deliverable checkpoints. Send revisions to the existing author conversation and assign each candidate explicitly to review. Preserve successful siblings when another child fails. You decide sequencing, research sufficiency and when to defer. ${run.definition_version >= 22 ? '' : 'complete_content_group requires all items ready for human publication review; it never publishes articles.'}${run.definition_version >= 22 ? `\n${CONTENT_DELEGATION_INSTRUCTIONS}\n${CONTENT_COMPLETION_DESCRIPTION}` : ''}`,
    context: async task => {
      const site = await getSiteForWorkspace(env.DB, task.workspace_id, task.site_id);
      const sources = await loadContentProductionContext(env.DB, site!, run);
      const locales = new Set<string>();
      for (const source of sources) {
        const material = source.value as { items?: Array<{ source_locale?: string; translate_locales_json?: string }> };
        for (const item of material.items || []) {
          if (item.source_locale) locales.add(item.source_locale);
          try { for (const locale of JSON.parse(item.translate_locales_json || '[]') as string[]) locales.add(locale); } catch { /* Match the assignment's empty translation fallback. */ }
        }
      }
      return { sources, state: await inspect(task),
        ...(authorLinks ? { internal_linking: authorContentLinkContext(contentLinkPolicy(site!), [...locales]) } : {}),
      };
    }, completionInstructions: 'Inspect outstanding work, delegate needed work, complete the ready group, or defer with a concrete reason.',
    tools: (task, operation) => createContentProductionToolRegistry(env, groupId, editorial, linking, authorLinks).mapTools(tool => {
      if (tool.name === 'inspect_content_group') return { ...tool, execute: async () => inspect(task!) };
      if (['start_article_tasks','start_content_reviews'].includes(tool.name)) return { ...tool, version: editorial && tool.name === 'start_article_tasks' ? 2 : tool.version,
        ...(tool.name === 'start_article_tasks' && run.definition_version <= 22 ? { description: LEGACY_START_ARTICLE_TASKS_DESCRIPTION } : {}),
        inputSchema: tool.name === 'start_article_tasks' ? writingSelection : selection, replaySafety: 'idempotent', execute: raw => dispatch(task!, operation!, raw, tool.name === 'start_content_reviews') };
      if (tool.name === 'complete_content_group') return { ...tool,
        ...(run.definition_version >= 22 ? { version: 3, description: CONTENT_COMPLETION_DESCRIPTION } : {}),
        replaySafety: 'idempotent', execute: async raw => {
        await finalizeContentGroup(env.DB, groupId);
        return { group_id: groupId, outcome: run.definition_version >= 22 ? 'completed' : 'awaiting_human_review',
          ...(run.definition_version >= 22 ? { judgment_summary: (raw as { judgment_summary: string }).judgment_summary } : {}),
          state: await inspect(task!) };
      }, completion: output => ({ status: 'completed', outcome: run.definition_version >= 22 ? 'completed' : 'awaiting_human_review', reason: run.definition_version >= 22 ? String((output as { judgment_summary: string }).judgment_summary) : 'Articles ready for publication review', output }) };
      if (tool.name === 'defer_content_group') return { ...tool, replaySafety: 'idempotent', execute: async raw => {
        const value = raw as {reason:string}; await markContentGroupAttention(env.DB, groupId, value.reason); return { ...value, group_id: groupId };
      }, completion: output => ({ status: 'waiting', outcome: 'deferred', reason: String((output as {reason:string}).reason), output }) };
      return tool;
    }),
  } });
  return { output: result.output, phase: result.status };
}
