import { z } from 'zod';
import { getSiteForWorkspace, listJobs } from '../db';
import { publishedVersions } from '../blog/render';
import { parseHubUrls } from '../blog/seo';
import { markdownSubsetIssues } from '../lib/qa';
import { editorialError, validateEditorialLocations, type EditorialCandidate } from './content-editorial';
import { articleHrefs, isContentInternalLink, validateContentLinkLimit } from './content-link-policy';
import { assertContentParent, loadLinkCandidate, type ContentCandidate, type LinkTarget } from './content-link-reading';
import { recordContentReviewInteraction } from './content-production';
import type { RuntimeAgentEnv } from './env';
import { bindOperation, resolveSlot, saveSlot } from './parameter-slots';
import { persistRuntimeJson } from './runtime-content';
import { readTaskOperation, requireTask, type AgentTask } from './task-store';
import { ToolContractError } from './tool-failure';
import type { RuntimeTool } from './tools';

const text = z.string().min(1);
export const editArticleInternalLinksInput = z.object({
  candidate_ref: text,
  edits: z.array(z.object({ locale: text, original_text: text, replacement_text: z.string(),
    target_refs: z.array(text), reason: text })).min(1),
  location_updates: z.array(z.object({ locale: text, original_quote: text, replacement_quote: text })).default([]),
  judgment_summary: text,
});
type EditInput = z.infer<typeof editArticleInternalLinksInput>;

function conflict(message: string): never {
  throw new ToolContractError(message, { kind: 'state_conflict', effects: 'none', issues: [],
    guidance: 'Read the current candidate or target again and revise the local edit. No candidate was changed by this attempt.' });
}

export function applyContentLinkEdits(candidate: ContentCandidate, args: EditInput, targets: LinkTarget[]) {
  const versions = structuredClone(candidate.versions);
  const contracts = structuredClone(candidate.seo_contract);
  const ranges = new Map<string, Array<{ start: number; end: number; replacement: string }>>();
  for (const [index, edit] of args.edits.entries()) {
    const version = candidate.versions.find(v => v.locale === edit.locale);
    if (!version) editorialError(`edits.${index}.locale`, 'Locale is absent from this candidate');
    const start = version.content.indexOf(edit.original_text);
    if (start < 0 || version.content.indexOf(edit.original_text, start + 1) >= 0) {
      editorialError(`edits.${index}.original_text`, 'Original text must occur exactly once; provide a larger exact passage or reread the candidate');
    }
    const localeRanges = ranges.get(edit.locale) || [];
    const end = start + edit.original_text.length;
    if (localeRanges.some(r => start < r.end && end > r.start)) editorialError(`edits.${index}`, 'Local edits overlap; combine them into one exact replacement');
    localeRanges.push({ start, end, replacement: edit.replacement_text }); ranges.set(edit.locale, localeRanges);
  }
  for (const version of versions) {
    for (const range of (ranges.get(version.locale) || []).sort((a, b) => b.start - a.start)) {
      version.content = version.content.slice(0, range.start) + range.replacement + version.content.slice(range.end);
    }
    const before = articleHrefs(candidate.versions.find(v => v.locale === version.locale)!.content);
    const after = articleHrefs(version.content);
    const external = (hrefs: string[]) => hrefs.filter(href => !isContentInternalLink(href, candidate.policy)).sort();
    if (JSON.stringify(external(before)) !== JSON.stringify(external(after))) editorialError('edits', 'This tool preserves external evidence links; use author revision for citation changes');
    // Existing links can be retained or removed. Every newly introduced destination must be observed.
    for (const href of after.filter(href => isContentInternalLink(href, candidate.policy) && !before.includes(href))) {
      if (!targets.some(t => t.locale === version.locale && t.href === href)) {
        editorialError('target_refs', `No selected target in ${version.locale} authorizes ${href}`);
      }
    }
    const issues = markdownSubsetIssues(version.locale, version.content);
    if (issues.length || !version.content.trim()) editorialError('edits', issues.map(i => i.message).join('; ') || 'Article body cannot be empty');
  }
  const editorial = contracts.editorial as EditorialCandidate | undefined;
  const locations = editorial ? [...editorial.coverage_response.flatMap(r => r.locations), ...editorial.claim_evidence.claims.flatMap(c => c.locations)] : [];
  for (const update of args.location_updates) {
    const matches = locations.filter(l => l.locale === update.locale && l.quote === update.original_quote);
    if (!matches.length) editorialError('location_updates', 'Original quote is absent from this candidate evidence and coverage locations');
    for (const location of matches) location.quote = update.replacement_quote;
  }
  validateEditorialLocations(versions, locations);
  return { versions, seo_contract: contracts, counts: validateContentLinkLimit(versions, candidate.policy) };
}

/** Resolve observed targets and confirm each is still what the parent observed. */
async function verifiedLinkTargets(env: RuntimeAgentEnv, task: AgentTask, groupId: string, candidate: ContentCandidate, refs: string[]): Promise<LinkTarget[]> {
  const targets: LinkTarget[] = [];
  const site = await getSiteForWorkspace(env.DB, task.workspace_id, task.site_id);
  const published = publishedVersions(await listJobs(env.DB, task.site_id, 'published'));
  for (const ref of new Set(refs)) {
    const target = await resolveSlot<LinkTarget>(env.DB, task, ref, 'content_link_target');
    if (target.job_id === candidate.job_id) editorialError('target_refs', 'An article is not its own related-page target');
    if (target.status === 'published') {
      const live = published.find(p => p.job.id === target.job_id && p.version.locale === target.locale);
      if (!live || live.version.content !== target.content || live.version.title !== target.title) conflict('Published target changed or is no longer live in the observed locale');
    } else if (target.status === 'candidate') {
      const sibling = await env.DB.prepare(`select a.* from content_artifacts a join jobs j on j.id=a.job_id
        where a.job_id=? and a.group_id=? and j.production_group_id=? order by a.attempt desc limit 1`)
        .bind(target.job_id, groupId, groupId).first<{ id: string; versions_json: string }>();
      if (!sibling || sibling.id !== target.artifact_id) conflict('Sibling target changed; read its current candidate');
      const version = (JSON.parse(sibling.versions_json) as Array<{ locale: string; content: string }>).find(v => v.locale === target.locale);
      if (!version || version.content !== target.content) conflict('Sibling locale differs from the observed target');
    } else {
      const localized = parseHubUrls(site?.hub_urls_json)[target.locale];
      const urls = localized ? [localized] : [];
      if (!localized && site?.product_origin) {
        try { urls.push(new URL(String(site.hub_path || '/'), site.product_origin).href); } catch { /* invalid configuration is not a target */ }
      }
      if (!urls.includes(target.href)) conflict('Configured product target changed');
    }
    targets.push(target);
  }
  return targets;
}

/** Persist a link-edited candidate as the next attempt, guarded by the parent's execution and latest-candidate state. */
async function saveLinkEditedCandidate(env: RuntimeAgentEnv, task: AgentTask, groupId: string, operationId: string,
  bound: { candidate: ContentCandidate; versions: ContentCandidate['versions']; seo_contract: Record<string, unknown>; counts: unknown; artifact_id: string; at: string }): Promise<ContentCandidate> {
  const replay = await env.DB.prepare('select id from content_artifacts where submission_operation_id=?').bind(operationId).first<{ id: string }>();
  if (!replay) {
    const c = bound.candidate;
    const contractJson = await persistRuntimeJson(env.DB, bound.seo_contract);
    // The caller's execution-scoped DB supplies the atomic execution fence as well as this domain CAS.
    const result = await env.DB.prepare(`insert into content_artifacts
      (id,group_id,job_id,decision_item_id,child_run_id,submission_operation_id,attempt,status,versions_json,seo_contract_json,qa_report_json,parent_review_json,supersedes_artifact_id,created_at,updated_at)
      select ?,?,?,?,?,?,?,'candidate',?,?,?,'{}',?,?,? where exists(
        select 1 from content_artifacts a join jobs j on j.id=a.job_id join content_production_groups g on g.id=a.group_id
        where a.id=? and a.status='candidate' and j.production_group_id=g.id and g.id=? and g.workspace_id=? and g.site_id=? and g.parent_run_id=?
        and j.status not in ('awaiting_review','publishing','published')
        and a.id=(select a2.id from content_artifacts a2 where a2.job_id=a.job_id order by a2.attempt desc limit 1))`)
      .bind(bound.artifact_id, groupId, c.job_id, c.decision_item_id, c.child_run_id, operationId, c.attempt + 1,
        JSON.stringify(bound.versions), contractJson, JSON.stringify({ ok: true, issues: [], internal_link_counts: bound.counts }), c.id, bound.at, bound.at,
        c.id, groupId, task.workspace_id, task.site_id, task.active_run_id).run();
    if (!result.meta.changes) conflict('Candidate or publication state changed after it was read');
  } else if (replay.id !== bound.artifact_id) conflict('Operation receipt belongs to another candidate');
  return { ...bound.candidate, id: bound.artifact_id, attempt: bound.candidate.attempt + 1,
    versions: bound.versions, seo_contract: bound.seo_contract, status: 'candidate' };
}

export function editArticleInternalLinksTool(env: RuntimeAgentEnv, groupId: string): RuntimeTool<EditInput, unknown> {
  return { name: 'edit_article_internal_links', version: 1, capability: 'write', approval: 'never', retryable: false,
    replaySafety: 'idempotent', timeoutMs: 60000, preserveOutputSize: true,
    inputSchema: editArticleInternalLinksInput, outputSchema: z.unknown(),
    description: 'Locally add, replace or remove internal links in an exact candidate_ref returned by read_content_article. Each original_text must occur once in the ORIGINAL body; replacements cannot overlap. Use exact link_href/url and target_refs returned by article reads or configured product targets, with matching locale. Preserve other prose and external evidence citations. Final total is at most 3 internal links per locale, including existing/repeated links; zero is allowed. If an evidence/coverage quote changes, supply its exact location_update without changing its claim or source. Saves a new candidate, preserving the original and author identity. Returns a diff, counts and new candidate_ref. Reinspect before assigning review. This cannot edit accepted/published articles or publish anything. If unchanged, skip this tool and record your judgment when assigning review.',
    execute: async (args, context) => {
      const task = await requireTask(env.DB, context.runId);
      await assertContentParent(env, task, groupId);
      const operation = await readTaskOperation(env.DB, task.id, task.next_turn);
      if (!operation || operation.id !== context.idempotencyKey) editorialError('operation', 'Edit requires the current persisted parent operation');
      const bound = await bindOperation(env.DB, task, operation, args, async () => {
        const candidate = await resolveSlot<ContentCandidate>(env.DB, task, args.candidate_ref, 'content_candidate');
        if (candidate.group_id !== groupId) editorialError('candidate_ref', 'Candidate belongs to another group');
        const current = await loadLinkCandidate(env, task, groupId, candidate.id);
        if (current.status !== 'candidate') conflict('Only an unreviewed candidate can be edited');
        const targets = await verifiedLinkTargets(env, task, groupId, candidate, args.edits.flatMap(edit => edit.target_refs));
        const edited = applyContentLinkEdits(candidate, args, targets);
        const previousTargets = (candidate.seo_contract.internal_link_targets || []) as LinkTarget[];
        edited.seo_contract.internal_link_targets = [...targets, ...previousTargets].filter((target, index, all) =>
          all.findIndex(t => t.href === target.href && t.locale === target.locale) === index
          && edited.versions.some(v => v.locale === target.locale && articleHrefs(v.content).includes(target.href)));
        // Keep target evidence attached to the exact candidate for independent review and revision.
        edited.seo_contract.internal_link_edit = { contract_version: 1, parent_run_id: task.active_run_id,
          source_artifact_id: candidate.id, judgment_summary: args.judgment_summary, edits: args.edits, targets };
        return { candidate, ...edited, targets, artifact_id: crypto.randomUUID(), at: new Date().toISOString() };
      });
      const candidate = await saveLinkEditedCandidate(env, task, groupId, operation.id, bound);
      await recordContentReviewInteraction(env.DB, { idempotencyKey: `internal-links:${operation.id}`, groupId, jobId: candidate.job_id,
        artifactId: candidate.id, parentRunId: task.active_run_id, childRunId: candidate.child_run_id,
        kind: 'parent_internal_links_edited', actorType: 'agent', actorId: 'content_production', summary: args.judgment_summary,
        payload: { source_artifact_id: bound.candidate.id, edits: args.edits, internal_link_counts: bound.counts }, at: bound.at });
      return { artifact_id: candidate.id, candidate_ref: await saveSlot(env.DB, task, 'content_candidate', candidate),
        job_id: candidate.job_id, attempt: candidate.attempt, internal_link_counts: bound.counts,
        diff: args.edits.map(edit => ({ locale: edit.locale, before: edit.original_text, after: edit.replacement_text, reason: edit.reason })),
        outcome: 'candidate_saved_for_independent_review' };
    } };
}
