import { AUTHOR_INTERNAL_LINK_INSTRUCTIONS, REVIEW_INTERNAL_LINK_INSTRUCTIONS } from './content-link-policy';
import type { RuntimeAgentEnv } from './env';
import { persistRuntimeJson, readRuntimeJson } from './runtime-content';
import type { AgentModuleExecutionContext } from './agent-modules';
import { runConversationTask } from './conversation-runtime';
import { getSiteForWorkspace } from '../db';
import { adaptArticleDraftModelResponse, createArticleProductionToolRegistry, submitArticleInputSchema, submitEditorialArticleInputSchema } from './article-production-tools';
import { createContentReviewToolRegistry, REVIEW_STRATEGY_FOCUS_INSTRUCTIONS, submitContentReviewInputSchema, submitEditorialReviewInputSchema, submitStrategyReviewInputSchema } from './content-review-tools';
import { applyContentReviewDecision, loadArticleProductionContext, loadContentReviewContext, persistArticleArtifact,
  contentReviewBody, validateArticleSubmission, type ArticleTask, type ContentReviewTask } from './content-production';
import { taskForRun, type AgentTask } from './task-store';
import { resolveSlot } from './parameter-slots';
import { editorialError, readContentSource, validateCoverageResponses, validateEditorialLocations, type EvidenceLedger, type EditorialCandidate } from './content-editorial';
import { ARTICLE_MARKDOWN_CAPABILITIES } from '../../shared/article-presentation';
import { AUTHOR_OWNED_LINK_INSTRUCTIONS, authorLinkIssues, withSitePublishedArticles } from './content-author-links';
import { AUTHOR_SELF_CHECK_INSTRUCTIONS, deliverArticleInput, prepareDelivery, resolveCurrentDraft, runArticleSelfCheck, runSelfCheckInput, type ArticleDraft } from './content-self-check';
import { saveSlot } from './parameter-slots';
import { ToolExecutionError } from './tool-failure';

// From article v18: build an understanding of the subject before drafting, instead of searching only to fill factual gaps.
const AUTHOR_RESEARCH_INSTRUCTIONS = 'Research before writing. Before drafting, build your own understanding of the subject as an experienced practitioner in this market would hold it, not only what the keyword implies. Start from the assigned rationale, evidence, brief and business facts, then investigate what remains unclear: how readers actually meet and handle this problem, the concrete situations and constraints they face, established methods and their trade-offs, common mistakes and misconceptions, the terms practitioners use, and relevant rules, data or recent changes. Prefer reading full original sources with read_article_source (official documentation, standards, credible research, experienced practitioners) over article_search_web snippets; a snippet is limited evidence, not proof that a whole source was read. Read pages readers already find for this intent to learn what they cover and where they are thin, generic or wrong; add what they miss rather than reproducing their outline. Scale the research to the subject: a narrow factual question may need little, an unfamiliar industry subject needs more. You are ready to write when you can explain the subject\'s key distinctions and trade-offs in your own words and support your substantive claims, not when a count is reached.\nThen decide the article\'s point of view: what the reader should understand or do differently afterwards, and which finding makes this page worth reading. Write from that understanding; use keywords as the reader\'s language, never as the substance. Record the claims you rely on with save_claim_evidence. Keep what you could not verify visible as uncertainty. If research shows the assigned angle is mistaken, unsupported or already fully served, say so: adjust within the brief with a stated reason, or defer_article with what you found.\nOn revision assignments, reuse your earlier research and investigate only what the feedback requires.';
// From review v11: generic keyword text is a material gap even when it is accurate and well formed.
const REVIEW_UNDERSTANDING_INSTRUCTIONS = 'Judge whether the article shows real understanding of the subject (concrete situations, distinctions, trade-offs and non-obvious points grounded in evidence) rather than generic statements any page targeting this keyword could contain. Name the generic passages and the understanding they lack.';

async function assignment<T>(env: RuntimeAgentEnv, task: AgentTask): Promise<T> {
  const row = await env.DB.prepare('select context_json from agent_task_assignments where id=? and task_id=?')
    .bind(task.assignment_id, task.id).first<{ context_json: string }>();
  if (!row) throw new Error('Task assignment is missing');
  return readRuntimeJson<T>(env.DB, row.context_json);
}
async function initializeAssignment(input: AgentModuleExecutionContext, task: AgentTask, review: boolean) {
  if (task.assignment_id) return assignment(input.env, task);
  const site = await getSiteForWorkspace(input.env.DB, task.workspace_id, task.site_id);
  if (!site) throw new Error('Task site is missing');
  const sources = await (review ? loadContentReviewContext : loadArticleProductionContext)(input.env.DB, site, input.run);
  const value = sources.find(source => source.sourceId === (review ? 'content_review_task' : 'article_task'))!.value;
  const id = `${task.id}:initial`;
  await input.env.DB.batch([
    input.env.DB.prepare('insert or ignore into agent_task_assignments(id,task_id,operation_id,context_json,created_at) values(?,?,?,?,?)')
      .bind(id, task.id, id, await persistRuntimeJson(input.env.DB, value), new Date().toISOString()),
    input.env.DB.prepare("update agent_tasks set assignment_id=? where id=? and assignment_id=''").bind(id, task.id),
  ]);
  return value;
}

function assignmentUpdate(env: RuntimeAgentEnv) {
  return async (task: AgentTask) => {
    if (!task.assignment_id || task.assignment_id.endsWith(':initial')) return null;
    const key = `assignment:${task.assignment_id}`;
    if (await env.DB.prepare('select 1 from agent_conversation_messages where task_id=? and message_key=?').bind(task.id, `context:${key}`).first()) return null;
    return { key, content: await assignment(env, task) };
  };
}

export async function runArticleConversation(input: AgentModuleExecutionContext) {
  const { env, definition, run } = input;
  const currentTask = await taskForRun(env.DB, run.id);
  const initial = currentTask ? await initializeAssignment(input, currentTask, run.agent_id === 'content_review') : null;
  const material = initial as ArticleTask & ContentReviewTask | null;
  const editorial = run.agent_id === 'article_production'
    ? material?.editorial_contract_version === 2
    : Boolean((material?.seo_contract as { editorial?: EditorialCandidate } | undefined)?.editorial);
  // From v17, under a parent that assigns the author-owned link contract, drafts are checked in a fresh session before delivery.
  const selfCheck = editorial && run.definition_version >= 17 && material?.author_link_contract === 1;
  const researchFirst = editorial && run.definition_version >= 18;
  const validatedDraft = async (raw: unknown, current: import('./task-store').AgentTask) => {
    // Authors may link to any published article in the site, not only the recent ones placed in the assignment.
    const article = await withSitePublishedArticles(env, current, await assignment<ArticleTask>(env, current));
    const parsed = submitEditorialArticleInputSchema.parse(raw);
    if (!article.coverage_plan) editorialError('coverage_plan', 'Assigned plan is missing');
    const ledger = await resolveSlot<EvidenceLedger>(env.DB, current, parsed.bundle.ledger_ref, 'content_evidence');
    if (ledger.job_id !== article.job_id) editorialError('ledger_ref', 'Ledger belongs to another article');
    validateCoverageResponses(article.coverage_plan, parsed.bundle.coverage_response);
    validateEditorialLocations(parsed.bundle.versions, parsed.bundle.coverage_response.flatMap(r => r.locations), 'bundle.coverage_response');
    validateEditorialLocations(parsed.bundle.versions, ledger.claims.flatMap(c => c.locations), `evidence ledger ${parsed.bundle.ledger_ref}`);
    const snapshot: EditorialCandidate = { contract_version: 2, coverage_plan: article.coverage_plan, claim_evidence: ledger, coverage_response: parsed.bundle.coverage_response };
    const bundle = { versions: parsed.bundle.versions, seo_contract: { ...parsed.bundle.seo_contract, factual_claims: [] } };
    const feedback = validateArticleSubmission(article, bundle);
    const linkIssues = authorLinkIssues(article, bundle.versions);
    return { article, snapshot, bundle, feedback: { ...feedback, accepted: feedback.accepted && !linkIssues.length, issues: [...feedback.issues, ...linkIssues] } };
  };
  const checkDraft = async (current: import('./task-store').AgentTask, operationId: string, draftRef: string, draft: ArticleDraft, article: ArticleTask) => {
    try {
      return await runArticleSelfCheck({ env, step: input.step, runId: run.id, operationId, definition, task: current, article, draftRef, draft });
    } catch (error) {
      // Only an unusable check result is reported here; execution and platform failures keep their own recovery.
      if (!(error instanceof ToolExecutionError)) throw error;
      return { draft_ref: draftRef, check_ref: null, self_check: null, self_check_error: error.message,
        guidance: 'The draft is saved. Call run_self_check with this draft_ref to check it again.' };
    }
  };
  const result = await runConversationTask({ env, step: input.step, runId: run.id, definition, agent: {
    auditCompletionTools: [selfCheck ? 'deliver_article' : 'submit_article'],
    adaptModelResponse: selfCheck ? adaptArticleDraftModelResponse : undefined,
    instructions: `${definition.mission}${selfCheck ? `\n${AUTHOR_OWNED_LINK_INSTRUCTIONS}` : run.definition_version >= 16 ? `\n${AUTHOR_INTERNAL_LINK_INSTRUCTIONS}` : ''}${researchFirst ? `\n${AUTHOR_RESEARCH_INSTRUCTIONS}` : ''}${editorial ? '\nUse the assigned coverage_plan and save_claim_evidence before submission. Submit ledger_ref and coverage_response for that exact candidate in every locale. Any justified disposition is allowed, including moving or deferring a question. Read original source snapshots with read_article_source, following next_offset when necessary. Persist exact quotes and limits, not self-rated confidence. Revise the ledger when wording or article locations change. Read previous_editorial on revision and preserve useful evidence. An empty ledger is legitimate if no claims need external support; never hide factual claims to avoid review.' : ''}\nYou own one continuous article conversation. Follow the assigned editorial brief and revision feedback. ${researchFirst ? '' : 'Use article_search_web when factual gaps need investigation; search snippets are limited evidence, not proof that a whole source was read. '}Use confirmed business facts, strategy and evidence; do not invent claims or source support. Preserve valid prior writing and use targeted repairs. Choose structure and depth for the reader. Design the actual page around the assigned primary intent and market. Use available search evidence to investigate useful sub-intents and scenarios when needed, distinguishing observed results from hypotheses; do not claim keyword demand or competitor-page findings from unsupported snippets. Make the title clearly describe the main reader task and, when appropriate to the intent, give a useful direct answer early in the visible article before detailed explanation. The seo_contract describes the delivered article: its direct_answer and factual_claims must be reflected in the visible content, not only in submission metadata. Choose definitions, explanations, examples, templates, comparisons and FAQs only where they help readers complete distinct tasks; avoid redundant sections and overlap with sibling pages. Use natural query language without exact-match quotas or a required word count. For substantive factual or learning-effect claims, cite evidence that actually supports the claim, explain relevant limitations, and distinguish illustrative examples from verified facts. A definition or confident tone alone is not authority.${selfCheck ? '' : ' Link to verified relevant published articles when useful.'} Connect a reader problem to a useful method and then to verified product capabilities where appropriate; do not force a promotion or promise rankings, AI citations or learning outcomes. Use the complete official product name from confirmed business facts every time you name a product, including headings, examples, localized versions and calls to action. Never shorten it, invent an abbreviation or translate the name without an explicitly approved official localized full name. Preserve verified product capability boundaries; do not imply unsupported capabilities or outcomes. Every required locale must be represented exactly once. ${selfCheck ? `Read published articles when they help avoid duplication. Validation errors return as observations. Later revision assignments continue this conversation. Publication remains subject to the existing business approval.\n${AUTHOR_SELF_CHECK_INSTRUCTIONS}` : 'Read published articles when they help avoid duplication or establish useful links. Submit a complete candidate with submit_article; validation errors return as observations. An accepted submission saves a deliverable checkpoint and waits for the parent editor. Later revision assignments continue this conversation. Publication remains subject to the existing business approval.'}\n${ARTICLE_MARKDOWN_CAPABILITIES}`,
    context: task => initializeAssignment(input, task, false),
    contextUpdates: [assignmentUpdate(env)],
    completionInstructions: selfCheck
      ? 'Save and check the draft, then deliver the checked candidate, continue useful work, or defer_article with a concrete reason and resume condition.'
      : 'Submit the completed article candidate, continue useful work, or defer_article with a concrete reason and resume condition.',
    tools: (task) => createArticleProductionToolRegistry(env, editorial, selfCheck).mapTools(tool => {
      if (tool.name === 'save_article_draft') return { ...tool, replaySafety: 'idempotent', execute: async (raw, context) => {
        const current = (await taskForRun(env.DB, context.runId))!;
        const { article, snapshot, bundle, feedback } = await validatedDraft(raw, current);
        if (!feedback.accepted) return { ...feedback, effects: 'none', guidance: 'Preserve valid writing and correct the listed contract issues before saving the draft again.' };
        const draft: ArticleDraft = { assignment_id: current.assignment_id, bundle, editorial: snapshot };
        const draftRef = await saveSlot(env.DB, current, 'article_draft', draft);
        return { accepted: true, ...await checkDraft(current, context.idempotencyKey, draftRef, draft, article) };
      } };
      if (tool.name === 'run_self_check') return { ...tool, replaySafety: 'idempotent', execute: async (raw, context) => {
        const current = (await taskForRun(env.DB, context.runId))!;
        const args = runSelfCheckInput.parse(raw);
        const draft = await resolveCurrentDraft(env, current, args.draft_ref);
        return checkDraft(current, context.idempotencyKey, args.draft_ref, draft, await assignment<ArticleTask>(env, current));
      } };
      if (tool.name === 'deliver_article') return { ...tool, replaySafety: 'idempotent', execute: async (raw, context) => {
        const current = (await taskForRun(env.DB, context.runId))!;
        const article = await withSitePublishedArticles(env, current, await assignment<ArticleTask>(env, current));
        const { draft, extras } = await prepareDelivery(env, current, deliverArticleInput.parse(raw));
        const saved = await persistArticleArtifact(env, run.id, article, draft.bundle, context.idempotencyKey, draft.editorial, extras);
        return { accepted: true, outcome: 'submitted', artifact_id: saved.artifactId, job_id: saved.jobId, attempt: saved.attempt, locale_count: saved.localeCount,
          declined_findings: extras.self_check.declined_findings.length };
      }, completion: output => (output as { accepted?: boolean }).accepted ? { status: 'waiting', outcome: 'submitted', reason: 'Checked candidate delivered; waiting for the next parent assignment', output } : undefined };
      if (tool.name === 'submit_article') return { ...tool, replaySafety: 'idempotent',
        execute: async (raw, context) => {
          const current = (await taskForRun(env.DB, context.runId))!;
          const article = await assignment<ArticleTask>(env, current);
          let snapshot: EditorialCandidate | undefined;
          let args;
          if (editorial) {
            const parsed = submitEditorialArticleInputSchema.parse(raw);
            if (!article.coverage_plan) editorialError('coverage_plan', 'Assigned plan is missing');
            const ledger = await resolveSlot<EvidenceLedger>(env.DB, current, parsed.bundle.ledger_ref, 'content_evidence');
            if (ledger.job_id !== article.job_id) editorialError('ledger_ref', 'Ledger belongs to another article');
            validateCoverageResponses(article.coverage_plan, parsed.bundle.coverage_response);
            validateEditorialLocations(parsed.bundle.versions, parsed.bundle.coverage_response.flatMap(r => r.locations), 'bundle.coverage_response');
            validateEditorialLocations(parsed.bundle.versions, ledger.claims.flatMap(c => c.locations), `evidence ledger ${parsed.bundle.ledger_ref}`);
            snapshot = { contract_version: 2, coverage_plan: article.coverage_plan, claim_evidence: ledger, coverage_response: parsed.bundle.coverage_response };
            args = { bundle: { versions: parsed.bundle.versions, seo_contract: { ...parsed.bundle.seo_contract, factual_claims: [] } } };
          } else args = submitArticleInputSchema.parse(raw);
          const feedback = validateArticleSubmission(article, args.bundle);
          if (!feedback.accepted) return { ...feedback, effects: 'none', guidance: 'Preserve valid writing and correct the listed contract issues.' };
          const saved = await persistArticleArtifact(env, run.id, article, args.bundle, context.idempotencyKey, snapshot);
          return { accepted: true, outcome: 'submitted', artifact_id: saved.artifactId, job_id: saved.jobId, attempt: saved.attempt, locale_count: saved.localeCount };
        }, completion: output => (output as { accepted?: boolean }).accepted ? { status: 'waiting', outcome: 'submitted', reason: 'Candidate saved; waiting for the next parent assignment', output } : undefined };
      if (tool.name === 'defer_article') return { ...tool, replaySafety: 'idempotent', execute: async raw => ({ ...raw as object, task_id: task?.id, outcome: 'deferred' }),
        completion: output => ({ status: 'waiting', outcome: 'deferred', reason: String((output as {reason:string}).reason), output }) };
      return tool;
    }),
  } });
  return { output: result.output, phase: result.status };
}

export async function runReviewConversation(input: AgentModuleExecutionContext) {
  const { env, definition, run } = input;
  const currentTask = await taskForRun(env.DB, run.id);
  const initial = currentTask ? await initializeAssignment(input, currentTask, run.agent_id === 'content_review') : null;
  const material = initial as ArticleTask & ContentReviewTask | null;
  const editorial = run.agent_id === 'article_production'
    ? material?.editorial_contract_version === 2
    : Boolean((material?.seo_contract as { editorial?: EditorialCandidate } | undefined)?.editorial);
  // From v10, for candidates delivered under the author-owned link contract (they carry a fresh self-check),
  // the review covers strategy, topic, self-check and internal links. Earlier candidates keep the prior review contract.
  const strategyFocus = editorial && run.definition_version >= 10 && Boolean((material?.seo_contract as { self_check?: unknown } | undefined)?.self_check);
  const judgeUnderstanding = editorial && run.definition_version >= 11;
  const result = await runConversationTask({ env, step: input.step, runId: run.id, definition, agent: {
    auditCompletionTools: ['submit_content_review'],
    instructions: `${definition.mission}${run.definition_version >= 13 ? '\nEach versions[].content is the exact continuous article Markdown. JSON escaping describes transport, not visible punctuation. Review the decoded article text; quote only passages present in it. Legacy content_chunks, if encountered in historical material, concatenate with an empty separator and add no punctuation.' : ''}${strategyFocus ? `\n${REVIEW_STRATEGY_FOCUS_INSTRUCTIONS}` : run.definition_version >= 9 ? `\n${REVIEW_INTERNAL_LINK_INSTRUCTIONS}` : ''}${editorial ? '\nReturn coverage_findings for each assigned requirement and evidence_findings for every registered claim. Independently read the visible article to discover unregistered claims (empty claim_id); do not merely check the author ledger. Read attached immutable snapshots with read_article_source and verify support scope, counterevidence and language-specific overstatement. Cite exact candidate passages and explain concrete repairs. Empty source_ids or locations are appropriate for a missing answer or unavailable evidence; never invent them. Judge justified exclusions or deferrals on their merits. No score or priority mechanically decides pass/revise.' : ''}\nReview the exact candidate in the current persisted assignment. Read its material and evidence before judging reader value, intent fit, factual support and relationship to siblings. Mechanical QA does not replace editorial judgment. Evaluate the visible article against its assigned intent, market, editorial brief and available evidence, not just whether the seo_contract fields are filled. Check whether the title and opening help the reader find the main answer, whether selected sub-questions and scenarios are usefully resolved, and whether the page adds distinct value without unnecessary overlap. Compare claimed direct answers and evidence support with the actual text. Check that citations support the specific assertions, research uncertainty remains visible, examples are not presented as measured facts, and product positioning follows verified capabilities. Use the complete official product name from confirmed business facts every time you name a product, including headings, examples, localized versions and calls to action. Never shorten it, invent an abbreviation or translate the name without an explicitly approved official localized full name. Preserve verified product capability boundaries; do not imply unsupported capabilities or outcomes. Return concrete passages and targeted changes for material gaps; do not pass a polished but unsupported or unhelpful article. ${judgeUnderstanding ? `${REVIEW_UNDERSTANDING_INSTRUCTIONS} ` : ''}Do not demand exact keyword placement, a fixed number of templates, FAQs, citations or any universal outline. Structure, depth and evidence sufficiency remain editorial judgments. You have only the supplied evidence and tools: never imply independent external verification you did not perform; request targeted evidence through revision or defer when necessary. Submit pass or revise with actionable feedback; never substitute the newest candidate silently. A saved review yields a checkpoint to the parent and waits for another explicitly assigned candidate. Existing human publication approval remains required.`,
    context: task => initializeAssignment(input, task, true),
    contextUpdates: [assignmentUpdate(env)],
    completionInstructions: 'Submit an independent review of the assigned candidate or defer_content_review with a concrete reason.',
    tools: () => createContentReviewToolRegistry(env, editorial, strategyFocus).mapTools(tool => {
      if (tool.name === 'submit_content_review') return { ...tool, replaySafety: 'idempotent', execute: async (raw, context) => {
        const current = (await taskForRun(env.DB, context.runId))!;
        const review = await assignment<ContentReviewTask>(env, current);
        const decision = (strategyFocus ? submitStrategyReviewInputSchema : editorial ? submitEditorialReviewInputSchema : submitContentReviewInputSchema).parse(raw);
        if (editorial) {
          const checked = submitEditorialReviewInputSchema.parse(raw);
          const snapshot = (review.seo_contract as { editorial: EditorialCandidate }).editorial;
          const ids = checked.coverage_findings.map(f => f.requirement_id);
          if (ids.length !== snapshot.coverage_plan.requirements.length || new Set(ids).size !== ids.length || ids.some(id => !snapshot.coverage_plan.requirements.some(r => r.id === id))) editorialError('coverage_findings', 'Check each assigned coverage requirement exactly once, including exclusions');
          const claims = snapshot.claim_evidence.claims;
          if (claims.some(c => !checked.evidence_findings.some(f => f.claim_id === c.id)) || checked.evidence_findings.some(f => f.claim_id && !claims.some(c => c.id === f.claim_id))) editorialError('evidence_findings', 'Assess all registered claims; use empty claim_id for newly discovered claims');
          for (const sourceId of new Set(checked.evidence_findings.flatMap(f => f.source_ids))) await readContentSource(env, current, sourceId);
          validateEditorialLocations(review.versions.map(v => ({ ...v, content: contentReviewBody(v) })), [...checked.coverage_findings, ...checked.evidence_findings].flatMap(f => f.locations));
        }
        const saved = await applyContentReviewDecision(env.DB, run.id, review, decision);
        return { outcome: 'reviewed', artifact_id: saved.artifactId, job_id: saved.jobId, decision: saved.decision };
      }, completion: output => ({ status: 'waiting', outcome: 'reviewed', reason: 'Review saved; waiting for another assigned candidate', output }) };
      if (tool.name !== 'defer_content_review') return tool;
      return { ...tool, replaySafety: 'idempotent', execute: async raw => ({ ...raw as object, outcome: 'deferred' }),
        completion: output => ({ status: 'waiting', outcome: 'deferred', reason: String((output as {reason:string}).reason), output }) };
    }),
  } });
  return { output: result.output, phase: result.status };
}
