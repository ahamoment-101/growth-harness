import { bindLearningDelegation, contentPractice, leaderOwnsLearning } from '../learning/leader';
import { leaderDeliveryView } from './delivery-view';
import { registerLeaderTopicReview } from './topic-review';
import { LEADER_COORDINATION_DELEGATE, LEADER_SCOPED_DELEGATE } from './coordination';
import { leaderObservation, readLeaderTopics } from './evidence-context';
import { leaderTodoTools } from './todo';
import { z } from 'zod';
import { ToolRegistry } from '../agent-runtime/tools';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from '../agent-runtime/env';
import type { AgentTask, TaskOperation } from '../agent-runtime/task-store';
import { taskForRun, TaskPendingError } from '../agent-runtime/task-store';
import { AGENT_IDS, agentDefinition, type AgentId } from '../agent-runtime/definitions';
import { runtimeAgentModule } from '../agent-runtime/agent-modules';
import { dispatchChildTask } from '../agent-runtime/task-children';
import { saveSlot, resolveSlot, bindOperation } from '../agent-runtime/parameter-slots';
import { researchPageTool } from '../agent-runtime/research-page-tool';
import { readRuntimeJson } from '../agent-runtime/runtime-content';
import { ToolContractError } from '../agent-runtime/tool-failure';
import { sourceIndex, readSource } from '../lib/research/evidence';
import { searchWeb } from '../lib/research/search';
import { listBusinessModules } from '../lib/business';
import { contentFromBusinessMarkdown } from '../../shared/business';
import { createConversation, enqueueInput } from './service';
import { topicInstance } from '../agent-runtime/topic-scope';
import { contentGroupInstance } from '../agent-runtime/content-production';
import { publicationQa, recordContentReviewInteraction } from '../agent-runtime/content-production';
import { getJobForWorkspace, getSiteForWorkspace } from '../db';
import { jobVersions } from '../lib/versions';
import { startPublish } from '../lib/dispatch';
import { generationLocales } from '../lib/webhook';
import { ARTICLE_PUBLISHED_TYPE, ARTICLE_REVIEW_TYPE, TASK_REPORT_TYPE, readAgentInbox } from '../agent-events/pool';

const delegationInputs: Partial<Record<AgentId, string>> = {
  strategy_research: 'scope_ref from discover_agents; goal, reason and context. Returns a strategy, research findings, or an evidence-backed no-change conclusion.',
  topic_decision: 'scope_ref from discover_agents (project language); goal, reason and context. Returns topics, a research need or a deferral. Topics still use the existing approval flow.',
  deep_research: 'scope_ref; goal is the research question, reason is the decision use, context carries evidence. Returns sources, findings and uncertainty.',
  content_production: 'target_ref from read_workspace content_groups. Only existing approved production groups can be delegated. Returns prepared articles and review conclusions; publication is separate.',
};
export function discoverableAgents(version = 1) {
  return AGENT_IDS.filter(id => delegationInputs[id] && (!runtimeAgentModule(id).parentAgentIds?.length || runtimeAgentModule(id).parentAgentIds!.includes('growth_leader')))
    .map(id => ({ agent_ref: id, name: agentDefinition(id).label, mission: agentDefinition(id).mission, input_and_result: version >= 15 && id !== 'content_production'
      ? `${delegationInputs[id]} Copy the chosen language's scope_ref from the scopes array into delegate_task.scope_ref (a top-level argument, not context).` : version >= 12 && id === 'topic_decision'
      ? 'Delegate a language-scoped topic goal. On completion, inspect the exact group with read_workspace topic_groups and decide approve or revise with review_topic_group; that decision can start production or return concrete feedback to a new topic task.' : version >= 8 && id === 'content_production'
      ? 'target_ref from read_workspace content_groups. Owns production and review of existing approved jobs in that group. Cannot allocate jobs for topic items without job references; those require the existing topic approval flow. Returns article deliveries or a concrete scope/capability blocker. Publication is separate.' : delegationInputs[id] }));
}
function invalid(message: string): never {
  throw new ToolContractError(message, { kind: 'invalid_request', effects: 'none', issues: [], guidance: 'Read current scoped references and use a supported action.' });
}
export function leaderTools(env: RuntimeAgentEnv, step: RuntimeWorkflowStep, task: AgentTask, operation?: TaskOperation) {
  const scope = { workspaceId: task.workspace_id, siteId: task.site_id };
  const common = { version: 1, timeoutMs: 60000, retryable: false, approval: 'never' as const, outputSchema: z.unknown() };
  const registry = new ToolRegistry();
  if (task.definition_version >= 12) registerLeaderTopicReview(registry, env, step, task, operation);
  registry.register({ ...common, name: 'discover_agents', version: task.definition_version >= 8 ? 2 : 1, capability: 'read', description: 'Discover actually callable specialist Agents, missions, input requirements and outcomes; also obtain configured language references.', inputSchema: z.object({}),
    execute: async () => {
      const site = await env.DB.prepare('select source_locale,translate_locales_json from sites where id=? and workspace_id=?').bind(task.site_id, task.workspace_id).first<{source_locale:string;translate_locales_json:string}>();
      const locales = [...new Set([site!.source_locale, ...JSON.parse(site!.translate_locales_json || '[]') as string[]])];
      return { agents: discoverableAgents(task.definition_version), scopes: await Promise.all(locales.map(async locale => ({ locale, scope_ref: await saveSlot(env.DB, task, 'leader_scope', { locale }) }))) };
    } });
  registry.register({ ...common, name: 'read_workspace', version: task.definition_version >= 12 ? 4 : task.definition_version >= 7 ? 3 : task.definition_version >= 4 ? 2 : common.version, capability: 'read', description: task.definition_version >= 12 ? 'Read attributed site records. topic_groups lists groups; target_ref reads a specific group, its actual items, rationale, evidence, risks, review state and updated_at for review_topic_group. Follow next_offset for all items. content_groups reads production records; article reads a specific article. Reads do not produce new work.' : task.definition_version >= 7 ? 'Read attributed site records. topic_groups lists actual topic groups; target_ref reads their items, review state and linked jobs. content_groups reads production records, not all planned topics. Use exact target_ref and next_offset. These reads observe existing objects; they do not produce new work. Overview task reasons are member-authored historical summaries.' : 'Read site overview, business documents with observed references, content groups, saved page evidence, or an article. Use source_ref and offset to finish long page reads; use target_ref for a content group or article.',
    inputSchema: z.object({ section: task.definition_version >= 7 ? z.enum(['overview','business','content_groups','topic_groups','articles','article','source']) : z.enum(['overview','business','content_groups','articles','article','source']), target_ref: z.string().optional(), source_ref: z.string().optional(), offset: z.number().int().nonnegative().default(0) }),
    execute: async (args: { section: string; target_ref?: string; source_ref?: string; offset: number }) => {
      const read = async () => {
        if (args.section === 'topic_groups') return readLeaderTopics(env, task, args.target_ref, args.offset);
        if (args.section === 'source') { const { source, content } = await readSource(env, task, args.source_ref || ''); return { source, excerpt: content.slice(args.offset,args.offset+16000), next_offset: args.offset+16000<content.length ? args.offset+16000 : null }; }
        if (args.section === 'business') return { documents: await Promise.all((await listBusinessModules(env.DB, task.site_id)).map(async d => ({ ...d, document_ref: await saveSlot(env.DB, task, 'leader_document', { key: d.key, version: d.version }) }))), sources: await sourceIndex(env, task.id), user_messages: (await env.DB.prepare("select id,content from leader_inputs where conversation_id=? and kind='user' order by created_at").bind(task.active_run_id).all()).results };
        if (args.section === 'content_groups') {
          if (task.definition_version >= 4 && args.target_ref) {
            const group = await env.DB.prepare(`select id as target_ref,decision_group_id,status,total_items,ready_items,failed_items,created_at,updated_at
              from content_production_groups where workspace_id=? and site_id=? and id=?`)
              .bind(task.workspace_id, task.site_id, args.target_ref).first();
            if (!group) invalid('Content group not found in this site');
            const items = (await env.DB.prepare(`select j.id as job_ref,j.decision_item_id,i.title_direction,i.primary_keyword,i.group_role,
              j.status,j.created_at,j.published_at,j.current_artifact_id
              from jobs j join topic_decision_items i on i.id=j.decision_item_id
              where j.production_group_id=? and j.site_id=? order by i.sort_order`)
              .bind(args.target_ref, task.site_id).all()).results;
            return { group, items };
          }
          return (await env.DB.prepare('select id as target_ref,decision_group_id,status from content_production_groups where workspace_id=? and site_id=? order by created_at desc limit 50').bind(task.workspace_id, task.site_id).all()).results;
        }
        if (args.section === 'articles') return (await env.DB.prepare(`select id as target_ref,en_title as title,source_locale,status${task.definition_version >= 7 ? ',created_at,published_at,current_artifact_id,production_group_id' : ''} from jobs where site_id=? order by created_at desc limit 50`).bind(task.site_id).all()).results;
        if (args.section === 'article') return await env.DB.prepare(`select id,en_title as title,source_locale,status,versions_json${task.definition_version >= 7 ? ',created_at,published_at,current_artifact_id,production_group_id' : ''} from jobs where site_id=? and id=?`).bind(task.site_id,args.target_ref || '').first();
        return { site: await env.DB.prepare('select name,domain,root_domain,source_locale,translate_locales_json,product_brief from sites where id=? and workspace_id=?').bind(task.site_id,task.workspace_id).first(),
          tasks: (await env.DB.prepare('select id as task_ref,agent_id,status,reason from agent_tasks where workspace_id=? and site_id=? and (id=? or parent_task_id=?) order by updated_at desc limit 50').bind(task.workspace_id, task.site_id, task.id, task.id).all()).results,
          documents: (await listBusinessModules(env.DB, task.site_id)).map(d => ({ key: d.key, version: d.version })),
          strategies: (await env.DB.prepare('select id,source_locale,status from seo_strategy_runs where site_id=? order by started_at desc limit 20').bind(task.site_id).all()).results };
      };
      const data = await read();
      return task.definition_version >= 7 ? leaderObservation('workspace_records', `read_workspace:${args.section}:${args.target_ref || 'list'}:offset=${args.offset}`, data) : data;
    } });
  if (task.definition_version >= 3) {
    registry.register({ ...common, name: 'read_my_inbox', version: task.definition_version >= 13 ? 2 : 1, capability: 'read', description: 'Read only actionable events delivered to this Agent and site. Event refs identify exact observed versions; inspect current business state before acting. Article events include the observed site publication language policy and its policy_ref when available.',
      inputSchema: z.object({}), execute: async () => {
        const events = await readAgentInbox(env.DB, { ...scope, agentId: 'growth_leader' }, task.active_run_id);
        const subscriptions = (await env.DB.prepare("select type from agent_event_subscriptions where agent_id='growth_leader' and enabled=1 order by type").all<{type:string}>()).results.map(row=>row.type);
        return { subscriptions, events: await Promise.all(events.map(async event => {
          if (event.type !== ARTICLE_REVIEW_TYPE) return event;
          const artifact = await env.DB.prepare('select parent_review_json,qa_report_json,versions_json from content_artifacts where id=? and job_id=?')
            .bind(event.subject_version, event.subject_id).first<{parent_review_json:string;qa_report_json:string;versions_json:string}>();
          const site = task.definition_version >= 13 ? await getSiteForWorkspace(env.DB, task.workspace_id, task.site_id) : null;
          const publicationPolicy = site ? { mode: site.publication_language_mode, enabled_locales: generationLocales(site) } : null;
          return { ...event, reviewer: artifact ? await readRuntimeJson(env.DB, artifact.parent_review_json) : null,
            qa: artifact ? JSON.parse(artifact.qa_report_json || '{}') : null,
            versions: artifact ? (JSON.parse(artifact.versions_json || '[]') as Array<{locale:string;title:string}>).map(v => ({locale:v.locale,title:v.title})) : [],
            ...(publicationPolicy ? { publication_policy: publicationPolicy,
              publication_policy_ref: await saveSlot(env.DB, task, 'leader_publication_policy', publicationPolicy) } : {}) };
        })) };
      } });
    registry.register({ ...common, name: 'complete_inbox_event', capability: 'write', replaySafety: 'idempotent',
      description: 'Mark a specialist task report or actual-publication notice as handled after checking its result and deciding what follow-up is needed. Article review events must use decide_publication instead.',
      inputSchema: z.object({ event_ref: z.string().min(1), reason: z.string().trim().min(1) }),
      execute: async args => {
        const result = await env.DB.prepare(`update agent_event_deliveries set status='completed',resolved_at=?,operation_id=?,decision='handled',result_ref=?
          where event_id=? and agent_id='growth_leader' and workspace_id=? and site_id=? and target_run_id=?
            and status in ('pending','delivered') and operation_id=''
            and exists(select 1 from agent_pool_events e where e.id=event_id and e.type in (?,?))`)
          .bind(new Date().toISOString(),operation!.id,args.reason.slice(0,1000),args.event_ref,task.workspace_id,task.site_id,task.active_run_id,TASK_REPORT_TYPE,ARTICLE_PUBLISHED_TYPE).run();
        if (result.meta.changes) return { event_ref: args.event_ref, completed: true };
        const prior = await env.DB.prepare(`select status,operation_id from agent_event_deliveries where event_id=? and agent_id='growth_leader'
          and workspace_id=? and site_id=? and target_run_id=? and exists(select 1 from agent_pool_events e where e.id=event_id and e.type in (?,?))`)
          .bind(args.event_ref,task.workspace_id,task.site_id,task.active_run_id,TASK_REPORT_TYPE,ARTICLE_PUBLISHED_TYPE).first<{status:string;operation_id:string}>();
        if (prior?.status === 'completed' && prior.operation_id === operation!.id) return { event_ref: args.event_ref, completed: true, replay: true };
        invalid('This task report is not actionable in this Leader conversation');
      } });
    registry.register({ ...common, name: 'decide_publication', version: task.definition_version >= 13 ? 2 : 1, capability: 'write', replaySafety: 'idempotent', executionMode: 'durable_call',
      description: 'Decide an observed article publication event. Publish only after reading the article and reviewer evidence. Publish reruns current objective QA and dispatches the existing publish Workflow. For v13, pass publication_policy_ref from read_my_inbox; the saved site policy determines whether missing enabled languages are localized after the source goes live. Revise returns only this article to the original content team with concrete required changes. A stale article/version is rejected. For decision-critical uncertainty use request_human_input before this tool.',
      inputSchema: z.object({ event_ref: z.string().min(1), decision: z.enum(['publish','revise']), reason: z.string().trim().min(1), required_changes: z.array(z.string().trim().min(1)).default([]), publication_policy_ref: task.definition_version >= 13 ? z.string().min(1) : z.string().optional() }),
      execute: async args => {
        const op = operation!;
        const delivery = await env.DB.prepare(`select e.subject_id,e.subject_version,e.type,d.status,d.result_ref,d.decision,d.operation_id from agent_event_deliveries d
          join agent_pool_events e on e.id=d.event_id where d.event_id=? and d.agent_id='growth_leader' and d.workspace_id=? and d.site_id=?
            and (d.target_run_id=? or (d.target_run_id='' and ?=?))`)
          .bind(args.event_ref,task.workspace_id,task.site_id,task.active_run_id,task.active_run_id,`publication:${task.site_id}`)
          .first<{subject_id:string;subject_version:string;type:string;status:string;result_ref:string;decision:string;operation_id:string}>();
        if (!delivery || delivery.type !== ARTICLE_REVIEW_TYPE) invalid('Article review event is not delivered to this Leader');
        if (delivery.operation_id && (delivery.operation_id !== op.id || delivery.decision !== args.decision)) invalid('This event already has a different publication decision');
        if (delivery.status === 'superseded') return { decision: args.decision, job_id: delivery.subject_id, superseded: true, reason: 'Article state changed before this decision completed' };
        if (delivery.status === 'completed') return { decision: args.decision, job_id: delivery.subject_id, result_ref: delivery.result_ref, replay: true };
        const job = await getJobForWorkspace(env.DB,task.workspace_id,delivery.subject_id);
        if (!job || job.site_id !== task.site_id || job.current_artifact_id !== delivery.subject_version) invalid('Article or reviewed version changed; reread the inbox');
        if (!job.production_group_id) invalid('Article has no content production group');
        const artifact = await env.DB.prepare('select status,versions_json from content_artifacts where id=? and job_id=?')
          .bind(delivery.subject_version,job.id).first<{status:string;versions_json:string}>();
        const continuing = delivery.operation_id === op.id;
        if (!continuing && (job.status !== 'awaiting_review' || !artifact || artifact.status !== 'accepted' || artifact.versions_json !== job.versions_json)) invalid('Accepted article changed; request a new review');
        if (args.decision === 'revise' && !args.required_changes.length) invalid('A revision needs concrete required_changes');
        if (args.decision === 'publish' && job.status === 'awaiting_review') {
          const site = await getSiteForWorkspace(env.DB,task.workspace_id,task.site_id);
          if (!site) invalid('Site no longer exists');
          const versions = jobVersions(job);
          const report = await publicationQa(env.DB,site as unknown as Record<string,unknown>,job,versions,versions.map(v=>v.locale));
          if (!report.ok) invalid(`Publication QA failed: ${report.issues.map(i=>i.message).join('; ')}`);
        }
        let localizationLocales: string[] | undefined;
        if (args.decision === 'publish' && task.definition_version >= 13) {
          const observed = await resolveSlot<{mode:string;enabled_locales:string[]}>(env.DB, task, args.publication_policy_ref || '', 'leader_publication_policy');
          const site = await getSiteForWorkspace(env.DB,task.workspace_id,task.site_id);
          if (!site || (!continuing && (observed.mode !== (site.publication_language_mode || 'all_enabled') || JSON.stringify(observed.enabled_locales) !== JSON.stringify(generationLocales(site))))) invalid('Publication language policy changed; reread the inbox');
          const existing = new Set(jobVersions(job).map(version => version.locale.toLowerCase()));
          localizationLocales = observed.mode === 'source_only' ? [] : observed.enabled_locales.filter(locale => !existing.has(locale.toLowerCase()));
        }
        if (!continuing) {
          const claim = await env.DB.prepare(`update agent_event_deliveries set operation_id=?,decision=? where event_id=? and agent_id='growth_leader'
            and operation_id='' and status in ('pending','delivered')`)
            .bind(op.id,args.decision,args.event_ref).run();
          if (!claim.meta.changes) invalid('Another decision already claimed this publication event');
        }
        let resultRef = '';
        if (args.decision === 'publish') {
          if (job.status === 'awaiting_review' || (job.status === 'publishing' && job.publication_operation_id === op.id)) {
            await startPublish(env as Env,job.id,{ artifactId: delivery.subject_version, versionsJson: artifact!.versions_json, operationId: op.id, localizationLocales });
          } else if (job.status !== 'published' || !job.workflow_id || job.publication_operation_id !== op.id) {
            throw new TaskPendingError('Publication effect needs reconciliation before this decision can resume');
          }
          resultRef = `job:${job.id}:publishing`;
          await recordContentReviewInteraction(env.DB,{idempotencyKey:`leader-published:${args.event_ref}`,groupId:job.production_group_id,
            jobId:job.id,artifactId:delivery.subject_version,parentRunId:task.active_run_id,childRunId:job.child_run_id,
            kind:'leader_approved',actorType:'agent',actorId:'growth_leader',summary:`AI Growth Leader approved publishing: ${args.reason}`});
        } else {
          const at = new Date().toISOString();
          const note = args.required_changes.join('; ');
          if (job.status === 'awaiting_review') {
            const results = await env.DB.batch([
              env.DB.prepare(`update content_production_groups set status='needs_attention',ready_items=max(0,ready_items-1),error='',updated_at=?
                where id=? and workspace_id=? and site_id=? and exists(select 1 from jobs where id=? and status='awaiting_review' and current_artifact_id=?)`)
                .bind(at,job.production_group_id,task.workspace_id,task.site_id,job.id,delivery.subject_version),
              env.DB.prepare(`update content_artifacts set status='rejected',updated_at=? where id=? and job_id=? and status='accepted'
                and exists(select 1 from jobs where id=? and status='awaiting_review' and current_artifact_id=?)`)
                .bind(at,delivery.subject_version,job.id,job.id,delivery.subject_version),
              env.DB.prepare(`update jobs set status='drafting',review_note=?,review_operation_id=?,error='',updated_at=? where id=? and site_id=?
                and status='awaiting_review' and current_artifact_id=?`)
                .bind(note,op.id,at,job.id,task.site_id,delivery.subject_version),
            ]);
            if (!results[2]?.meta.changes) invalid('Article changed during revision request');
          } else if (!continuing || job.status !== 'drafting' || job.review_note !== note || artifact?.status !== 'rejected') {
            invalid('Article changed after the revision decision');
          }
          await recordContentReviewInteraction(env.DB,{idempotencyKey:`leader-revision:${args.event_ref}`,groupId:job.production_group_id,
            jobId:job.id,artifactId:delivery.subject_version,parentRunId:task.active_run_id,childRunId:job.child_run_id,
            kind:'leader_revision_requested',actorType:'agent',actorId:'growth_leader',summary:`AI Growth Leader returned for revision: ${args.reason}`,
            payload:{required_changes:args.required_changes}});
          const learning = await bindLearningDelegation(env, task, op, await contentPractice(env, task, job.production_group_id));
          const assigned={goal:`Revise article ${job.id}`,reason:args.reason,context: learning?.guidance.length ? `${note}\nBusiness guidance: ${learning.guidance.join('\n')}` : note};
          const child=await dispatchChildTask({env,step,task,operation:op,agentId:'content_production',
            summary:{group_id:job.production_group_id,decision_group_id:job.decision_group_id,human_revision_job_id:job.id,delegation:assigned},
            instanceId:contentGroupInstance(job.production_group_id),assignment:assigned});
          resultRef=`task:${child.task.id}`;
        }
        await env.DB.prepare(`update agent_event_deliveries set status='completed',resolved_at=?,result_ref=?
          where event_id=? and agent_id='growth_leader' and operation_id=? and status in ('pending','delivered','waiting')`)
          .bind(new Date().toISOString(),resultRef,args.event_ref,op.id).run();
        return { decision: args.decision, job_id: job.id, result_ref: resultRef };
      } });
  }
  registry.register(researchPageTool(env, 'read_web_page'));
  registry.register({ ...common, name: 'search_web', capability: 'external', replaySafety: 'repeatable', description: 'Search public web evidence. Search excerpts are preliminary; read important source pages.',
    inputSchema: z.object({ queries: z.array(z.string().min(1)).min(1), country: z.string().optional() }),
    execute: async (args, ctx) => { if (!env.FIRECRAWL_API_KEY) invalid('Web search is not configured'); return searchWeb({ apiKey: env.FIRECRAWL_API_KEY!, queries: args.queries, country: args.country, signal: ctx.signal }); } });
  registry.register({ ...common, name: 'update_business_document', capability: 'write', replaySafety: 'idempotent', description: 'Revise an observed business document. Cite source_refs from read_web_page or user_message_refs from read_workspace business; preserve uncertain facts as uncertain.',
    inputSchema: z.object({ document_ref: z.string(), markdown: z.string().min(1), source_refs: z.array(z.string()).default([]), user_message_refs: z.array(z.string()).default([]) }),
    execute: async args => {
      const op = operation!;
      const prior = await env.DB.prepare('select module_key,version from business_module_versions where id=?').bind(`business:${op.id}`).first();
      if (prior) return prior;
      const doc = await resolveSlot<{key:Parameters<typeof contentFromBusinessMarkdown>[0];version:number}>(env.DB, task, args.document_ref, 'leader_document');
      const sources = await sourceIndex(env, task.id);
      if (!args.source_refs.length && !args.user_message_refs.length) invalid('Cite at least one observed source or user message');
      if (args.source_refs.some(id => !sources.some(s => s.id===id))) invalid('Unknown source reference');
      const messages = [];
      for (const id of args.user_message_refs) {
        const row = await env.DB.prepare("select id,content from leader_inputs where id=? and conversation_id=? and kind='user'").bind(id,task.active_run_id).first<{id:string;content:string}>();
        if (!row) invalid('Unknown user-message reference');
        messages.push(row);
      }
      const markdown = `${args.markdown}

## Information sources
${sources.filter(s=>args.source_refs.includes(s.id)).map(s=>`- ${s.url}`).join('\n')}
${messages.map(m=>`- User message ${m.id}: ${m.content}`).join('\n')}`;
      const result = await env.DB.prepare(`insert into business_module_versions(id,site_id,module_key,version,schema_version,content_json,markdown,source,created_at)
        select ?,?,?,?,1,?,?,'growth_leader',? where coalesce((select max(version) from business_module_versions where site_id=? and module_key=?),0)=?`)
        .bind(`business:${op.id}`,task.site_id,doc.key,doc.version+1,JSON.stringify(contentFromBusinessMarkdown(doc.key,markdown)),markdown,new Date().toISOString(),task.site_id,doc.key,doc.version).run();
      if (!result.meta.changes) invalid('Document changed after observation; reread it before revising');
      return { key: doc.key, version: doc.version+1 };
    } });
  registry.register({ ...common, name: 'delegate_task', version: task.definition_version >= 20 ? 6 : leaderOwnsLearning(task) ? 5 : task.definition_version >= 15 ? 4 : task.definition_version >= 8 ? 3 : task.definition_version >= 7 ? 2 : 1, capability: 'write', replaySafety: 'idempotent', executionMode: 'durable_call', description: leaderOwnsLearning(task) ? `${LEADER_SCOPED_DELEGATE} Pass practice_ref from your preparation when this delegation belongs to a learning practice. Related work reuses that reference. Put adopted business guidance in context; specialists do not use the learning protocol.${task.definition_version >= 20 ? ' practice_ref is required: select the prepared practice or explicitly pass null for work outside a learning practice. Verify the returned learning_practice_ref before claiming association.' : ''}` : task.definition_version >= 15 ? LEADER_SCOPED_DELEGATE : task.definition_version >= 8 ? LEADER_COORDINATION_DELEGATE : task.definition_version >= 7 ? 'Delegate an authorized goal to a discovered Agent. Separate observed facts from assumptions in context. Ask the member to verify consequential unknowns, report actual actions, artifact references and limitations, and revise the approach if premises fail. Acceptance is not delivery. content_production can produce/review existing jobs in the selected production group; it cannot allocate new jobs for unlinked topic items. Topic approval is the existing job-allocation entry point. A prose instruction cannot expand a specialist tool capability.' : 'Delegate a goal to a discovered Agent. Returns dispatch acceptance; the result will return to this conversation automatically. Read existing work before creating another task.',
    inputSchema: z.object({ agent_ref: z.string(), goal: z.string().min(1), reason: z.string().min(1), context: z.string().default(''), scope_ref: z.string().optional(), target_ref: z.string().optional(), ...(task.definition_version >= 20 ? { practice_ref: z.string().min(1).nullable() } : leaderOwnsLearning(task) ? { practice_ref: z.string().optional() } : {}) }),
    execute: async args => {
      const selected = discoverableAgents().find(a=>a.agent_ref===args.agent_ref);
      if (!selected) invalid('Agent is not callable by this Leader');
      const assigned = { goal: args.goal, reason: args.reason, context: args.context };
      let summary: Record<string,unknown>;
      let instanceId: string | undefined;
      if (selected.agent_ref === 'content_production') {
        const group = await env.DB.prepare('select id,decision_group_id from content_production_groups where id=? and workspace_id=? and site_id=?').bind(args.target_ref || '',task.workspace_id,task.site_id).first<{id:string;decision_group_id:string}>();
        if (!group) invalid('Use an existing approved production group; topic approval creates the group');
        summary = { group_id: group.id, decision_group_id: group.decision_group_id }; instanceId = contentGroupInstance(group.id);
      } else {
        if (!args.scope_ref) {
          throw new ToolContractError('Missing scope_ref for this specialist delegation', { kind: 'invalid_request', effects: 'none',
            issues: [{ path: ['scope_ref'], message: `Required for ${selected.agent_ref}; choose the language's scope_ref returned by discover_agents.scopes` }],
            guidance: 'Pass the selected scope_ref as the top-level delegate_task.scope_ref argument. Text in context does not supply this parameter. The delegation had no effects.' });
        }
        const { locale } = await resolveSlot<{locale:string}>(env.DB, task, args.scope_ref || '', 'leader_scope');
        if (selected.agent_ref === 'topic_decision') { summary = { scope: { locale }, locales: [locale], group_size: 10 }; instanceId = topicInstance({locale}); }
        else if (selected.agent_ref === 'deep_research') summary = { locale, research_question: args.goal, decision_use: args.reason, context: args.context, scope: '', deliverable: '' };
        else { summary = { locale, request: { requester: { type: 'agent', agent_id: 'growth_leader', task_id: task.id }, message: args.goal, context: { reason: args.reason, background: args.context } } }; instanceId = `strategy:${locale}`; }
      }
      const inherited = selected.agent_ref === 'content_production' ? await contentPractice(env, task, String(summary.group_id)) : null;
      const requested = 'practice_ref' in args ? args.practice_ref as string | null | undefined : undefined;
      if (requested && inherited && requested !== inherited) invalid('This production group already belongs to another practice');
      const learning = await bindLearningDelegation(env, task, operation!, requested || inherited);
      summary.delegation = assigned;
      const result = await dispatchChildTask({ env, step, task, operation: operation!, agentId: selected.agent_ref, summary, instanceId, assignment: assigned });
      return { task_ref: result.task.id, status: result.task.status, accepted: true, result_delivery: 'this_conversation',
        ...(task.definition_version >= 20 ? { learning_practice_ref: learning?.practice_ref || null } : {}),
        ...(task.definition_version >= 7 ? { receipt_kind: 'delegation_accepted', meaning: 'Work accepted; no completed business outcome is established by this receipt.' } : {}) };
    } });
  registry.register({ ...common, name: 'read_task', version: task.definition_version >= 8 ? 4 : task.definition_version >= 7 ? 3 : task.definition_version >= 4 ? 2 : 1, capability: 'read', description: task.definition_version >= 4
    ? 'Read a scoped task together with its saved assignment, status and delivered outcome. Relate this reply to the original delegation and the user request in your conversation. Does not expose specialist conversations.'
    : 'Read a scoped task status and delivered outcome. Does not expose specialist conversations.', inputSchema: z.object({ task_ref: z.string() }),
    execute: async args => {
      const row = await env.DB.prepare('select active_run_id from agent_tasks where id=? and workspace_id=? and site_id=? and (id=? or parent_task_id=?)').bind(args.task_ref,task.workspace_id,task.site_id,task.id,task.id).first<{active_run_id:string}>();
      if (!row) invalid('Task not found in this conversation or its direct delegations');
      const value = (await taskForRun(env.DB,row.active_run_id))!;
      const assignment = task.definition_version >= 4 && value.assignment_id
        ? await env.DB.prepare('select id,context_json,created_at from agent_task_assignments where id=? and task_id=?')
          .bind(value.assignment_id,value.id).first<{id:string;context_json:string;created_at:string}>() : null;
      const data = { task_ref: value.id, agent: value.agent_id, status: value.status, reason: value.reason,
        ...(task.definition_version >= 4 ? { assignment: assignment ? { id: assignment.id, created_at: assignment.created_at,
          material: await readRuntimeJson(env.DB,assignment.context_json) } : null } : {}),
        result: await readRuntimeJson(env.DB,value.output_json),
        ...(task.definition_version >= 7 ? { created_at: value.created_at, updated_at: value.updated_at, parent_task_ref: value.parent_task_id, belongs_to_this_delegation_chain: value.parent_task_id === task.id } : {}) };
      return task.definition_version >= 7 ? leaderObservation('task_report', `read_task:${value.id}`, task.definition_version >= 8 ? leaderDeliveryView(data) : data) : data;
    } });
  if (task.definition_version < 9) registry.register({ ...common, name: 'find_conversations', capability: 'read', description: 'Find this site’s Leader conversations or open one. Specialist internal conversations are not exposed.', inputSchema: z.object({ query: z.string().default(''), conversation_ref: z.string().optional() }),
    execute: async () => invalid('Reading other Leader conversations is no longer available') });
  registry.register({ ...common, name: 'create_conversation', capability: 'write', replaySafety: 'idempotent', executionMode: 'durable_call',
    description: task.definition_version >= 9
      ? 'Create a separate Leader conversation with a title and only the background needed for its initial purpose. Creator context is historical and cannot restrict later direct user requests. Optionally queue an already authorized initial request; creating a conversation does not expand authorization.'
      : 'Create a separate Leader conversation with a title and necessary context, linked to this conversation. Optionally queue an already authorized initial request; creating a conversation does not expand authorization.',
    inputSchema: z.object({ title: z.string().min(1), context: z.string(), initial_request: z.string().optional() }),
    execute: async args => {
      const { id } = await bindOperation(env.DB,task,operation!,args,async()=>({id:crypto.randomUUID()}));
      const conversation = await createConversation(env,scope,{id,title:args.title,context:args.context,sourceId:task.active_run_id});
      if (args.initial_request) await enqueueInput(env,scope,id,{id:`assignment:${operation!.id}`,kind:'assignment',actorId:'growth_leader',content:args.initial_request});
      // Controller dispatch after this execution ends keeps its captured write authority intact.
      return { conversation_ref: conversation.id, title: conversation.title, queued: Boolean(args.initial_request) };
    } });
  if (task.definition_version >= 5) {
    const todo = leaderTodoTools(env, task, operation);
    for (const name of todo.names()) registry.register(todo.resolve(agentDefinition('growth_leader'), name));
  }
  return registry;
}
