import { ToolContractError } from './tool-failure';
import type { CoveragePlan, EditorialCandidate, EditorialReview } from './content-editorial';
import { persistRuntimeJson, readRuntimeJson } from './runtime-content';
import { contentLinkCounts, contentLinkPolicy, describeContentInternalLinks, type DescribedInternalLink } from './content-link-policy';
const contentConflict = (message: string) => new ToolContractError(message, { kind: 'state_conflict', effects: 'none', issues: [], guidance: 'Inspect the current content state and select the explicitly assigned candidate.' });
import type { D1Database } from '@cloudflare/workers-types';
import { buildBusinessContext, listBusinessModules } from '../lib/business';
import { articleLinkQaInput, linkableArticles, runQa, siteLinkFacts, type QaReport } from '../lib/qa';
import { strategyVersionContext } from '../lib/research/strategy-store';
import type { ArticleVersion } from '../types';
import type { RuntimeAgentEnv } from './env';
import type { AgentRun } from './protocol';
import { runtimeJson } from './protocol';
import { type ContextSourceValue } from './context';
import type { SubmissionIssue } from './submission-contract';
import type { ArticleBundle } from './article-production-tools';
import { listRuntimeModelTrace } from './observability';

type ContentGroupRow = {
  id: string;
  workspace_id: string;
  site_id: string;
  decision_group_id: string;
  parent_run_id: string;
  status: string;
  total_items: number;
  ready_items: number;
  failed_items: number;
  review_round: number;
  review_json: string;
  error: string;
  created_at: string;
  updated_at: string;
};

export type ArticleTask = {
  internal_linking_contract?: 1;
  /** Set by content parents from v20: the author owns internal links and delivers after a fresh self-check. */
  author_link_contract?: 1;
  previous_candidate?: { artifact_id: string; versions: ArticleVersion[]; seo_contract: Record<string, unknown> };
  editorial_contract_version?: 1 | 2;
  coverage_plan?: CoveragePlan;
  previous_editorial?: EditorialCandidate;
  editorial_feedback?: ContentReviewDecision;
  group_id: string;
  decision_group_id: string;
  job_id: string;
  decision_item_id: string;
  source_locale: string;
  locales: string[];
  hub_path: string;
  /** Per-locale hub URLs and product origin travel with the task so the writer
   * is told, and the validator judges, the same thing the renderer will do. */
  hub_urls: Record<string, string>;
  product_origin: string;
  blog_origin: string;
  /** Live articles this one may link to, with the URL to use verbatim. */
  published_articles: Array<{ job_id: string; locale: string; title: string; url: string }>;
  /** Siblings in this group. They are written in parallel and have no slug yet,
   * so they can only be referenced by job_id. */
  group_articles: Array<{ job_id: string; title_direction: string; primary_keyword: string; locale: string }>;
  topic: Record<string, unknown>;
  group: Record<string, unknown>;
  business_context: string[];
  strategy_context: string[];
  evidence: unknown[];
  attempt: number;
  editorial_brief?: string;
  parent_feedback: string[];
  previous_artifact_id: string;
};

export type ParentReview = {
  group_summary: string;
  items: Array<{
    job_id: string;
    decision: 'pass' | 'revise';
    value_assessment: string;
    seo_geo_risks: string[];
    required_changes: string[];
  }>;
};

export type ContentReviewDecision = Partial<EditorialReview> & {
  decision: 'pass' | 'revise';
  value_assessment: string;
  seo_geo_risks: string[];
  required_changes: string[];
  judgment_summary: string;
};

/** Old persisted assignments retain chunks; new assignments carry exact, continuous Markdown. */
export type ContentReviewVersion = Omit<ArticleVersion, 'content'> & (
  { content: string; content_chunks?: never } | { content?: never; content_chunks: string[] }
);

export function contentReviewBody(version: ContentReviewVersion): string {
  return version.content ?? version.content_chunks.join('');
}

export type ContentReviewTask = {
  internal_linking_contract?: 1;
  /** Every internal link of the candidate with its placement and resolved target, for the reviewer's link checks. */
  internal_links?: DescribedInternalLink[];
  group_id: string;
  job_id: string;
  artifact_id: string;
  author_child_run_id: string;
  parent_run_id: string;
  attempt: number;
  task: Record<string, unknown>;
  group_objective: Record<string, unknown>;
  business_context: string[];
  strategy_context: string[];
  evidence: unknown[];
  seo_contract: Record<string, unknown>;
  deterministic_qa: Record<string, unknown>;
  versions: ContentReviewVersion[];
  sibling_context: Array<Record<string, unknown>>;
};

export type ContentGroupInspection = {
  group: {
    id: string;
    status: string;
    total_items: number;
    ready_items: number;
    failed_items: number;
    review_round: number;
    error: string;
  };
  items: Array<{
    job_id: string;
    decision_item_id: string;
    job_status: string;
    job_created_at?: string;
    published_at?: string;
    artifact_created_at?: string;
    review_note: string;
    title_direction: string;
    primary_keyword: string;
    group_role: string;
    artifact_id: string;
    artifact_status: string;
    attempt: number;
    parent_review: Record<string, unknown>;
    child_run_id: string;
    child_run_status: string;
    child_run_phase: string;
    child_run_error: string;
    child_run_output: Record<string, unknown>;
    review_run_id: string;
    review_run_status: string;
    review_run_phase: string;
    review_run_error: string;
    review_run_output: Record<string, unknown>;
  }>;
};

export type ContentReviewInteraction = {
  id: string;
  group_id: string;
  job_id: string;
  artifact_id: string;
  parent_run_id: string;
  child_run_id: string;
  kind: string;
  actor_type: string;
  actor_id: string;
  summary: string;
  payload: Record<string, unknown>;
  created_at: string;
};

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value || '') as T; } catch { return fallback; }
}

export async function inspectContentProductionGroup(
  db: D1Database,
  workspaceId: string,
  siteId: string,
  groupId: string,
  includeTimeline = false,
): Promise<ContentGroupInspection> {
  const group = await db.prepare(
    `select id, status, total_items, ready_items, failed_items, review_round, error
     from content_production_groups where id = ? and workspace_id = ? and site_id = ?`,
  ).bind(groupId, workspaceId, siteId).first<ContentGroupInspection['group']>();
  if (!group) throw new Error('Content production group was not found');
  const rows = await db.prepare(
    `select j.id as job_id, j.decision_item_id, j.status as job_status, j.review_note,
            ${includeTimeline ? 'j.created_at as job_created_at,j.published_at,a.created_at as artifact_created_at,' : ''}
            i.title_direction, i.primary_keyword, i.group_role,
            coalesce(a.id, '') as artifact_id, coalesce(a.status, '') as artifact_status,
            coalesce(a.attempt, 0) as attempt, coalesce(a.parent_review_json, '{}') as parent_review_json,
            coalesce(j.child_run_id, '') as child_run_id,
            coalesce(ar.status, '') as child_run_status, coalesce(ar.phase, '') as child_run_phase,
            coalesce(ar.error, '') as child_run_error, coalesce(ar.output_json, '{}') as child_run_output_json,
            coalesce((select rr.id from agent_runs rr
              where rr.workspace_id = ? and rr.site_id = ? and rr.agent_id = 'content_review'
                and rr.agent_instance_id = j.decision_item_id order by rr.created_at desc limit 1), '') as review_run_id,
            coalesce((select rr.status from agent_runs rr
              where rr.workspace_id = ? and rr.site_id = ? and rr.agent_id = 'content_review'
                and rr.agent_instance_id = j.decision_item_id order by rr.created_at desc limit 1), '') as review_run_status,
            coalesce((select rr.phase from agent_runs rr
              where rr.workspace_id = ? and rr.site_id = ? and rr.agent_id = 'content_review'
                and rr.agent_instance_id = j.decision_item_id order by rr.created_at desc limit 1), '') as review_run_phase,
            coalesce((select rr.error from agent_runs rr
              where rr.workspace_id = ? and rr.site_id = ? and rr.agent_id = 'content_review'
                and rr.agent_instance_id = j.decision_item_id order by rr.created_at desc limit 1), '') as review_run_error,
            coalesce((select rr.output_json from agent_runs rr
              where rr.workspace_id = ? and rr.site_id = ? and rr.agent_id = 'content_review'
                and rr.agent_instance_id = j.decision_item_id order by rr.created_at desc limit 1), '{}') as review_run_output_json
     from jobs j
     join topic_decision_items i on i.id = j.decision_item_id
     left join content_artifacts a on a.id = (
       select a2.id from content_artifacts a2 where a2.job_id = j.id order by a2.attempt desc limit 1
     )
     left join agent_runs ar on ar.id = j.child_run_id
     where j.production_group_id = ? order by i.sort_order asc`,
  ).bind(
    workspaceId, siteId, workspaceId, siteId, workspaceId, siteId,
    workspaceId, siteId, workspaceId, siteId, groupId,
  ).all<Record<string, unknown>>();
  for (const row of rows.results ?? []) row.parent_review_json = JSON.stringify(await readRuntimeJson(db, String(row.parent_review_json || '{}')));
  return {
    group: {
      ...group,
      total_items: Number(group.total_items), ready_items: Number(group.ready_items),
      failed_items: Number(group.failed_items), review_round: Number(group.review_round),
    },
    items: (rows.results ?? []).map((row) => ({
      job_id: String(row.job_id), decision_item_id: String(row.decision_item_id),
      job_status: String(row.job_status), review_note: String(row.review_note || ''), title_direction: String(row.title_direction),
      ...(includeTimeline ? { job_created_at: String(row.job_created_at || ''), published_at: String(row.published_at || ''),
        artifact_created_at: String(row.artifact_created_at || '') } : {}),
      primary_keyword: String(row.primary_keyword), group_role: String(row.group_role),
      artifact_id: String(row.artifact_id), artifact_status: String(row.artifact_status),
      attempt: Number(row.attempt || 0), parent_review: parseJson(String(row.parent_review_json || '{}'), {}),
      child_run_id: String(row.child_run_id), child_run_status: String(row.child_run_status),
      child_run_phase: String(row.child_run_phase), child_run_error: String(row.child_run_error),
      child_run_output: parseJson(String(row.child_run_output_json || '{}'), {}),
      review_run_id: String(row.review_run_id || ''), review_run_status: String(row.review_run_status || ''),
      review_run_phase: String(row.review_run_phase || ''), review_run_error: String(row.review_run_error || ''),
      review_run_output: parseJson(String(row.review_run_output_json || '{}'), {}),
    })),
  };
}

/** A new content task may take over a group only after its previous owner has ended. */
export async function claimContentProductionGroup(
  db: D1Database, workspaceId: string, siteId: string, groupId: string, runId: string,
): Promise<void> {
  const at = new Date().toISOString();
  const claimed = await db.prepare(`update content_production_groups
    set parent_run_id = ?, updated_at = ?
    where id = ? and workspace_id = ? and site_id = ? and parent_run_id != ?
      and (parent_run_id = ''
        or not exists (select 1 from agent_runs prior where prior.id = content_production_groups.parent_run_id)
        or exists (select 1 from agent_runs prior where prior.id = content_production_groups.parent_run_id
          and prior.status in ('succeeded', 'failed', 'cancelled')))`)
    .bind(runId, at, groupId, workspaceId, siteId, runId).run();
  if (claimed.meta.changes) return;
  const group = await db.prepare('select parent_run_id from content_production_groups where id=? and workspace_id=? and site_id=?')
    .bind(groupId, workspaceId, siteId).first<{ parent_run_id: string }>();
  if (!group) throw new Error('Content production group was not found');
  if (group.parent_run_id !== runId) throw new Error('Content production group is owned by an active Run');
}

export async function recordContentReviewInteraction(db: D1Database, input: {
  idempotencyKey: string;
  groupId: string;
  jobId: string;
  artifactId?: string;
  parentRunId?: string;
  childRunId?: string;
  kind: string;
  actorType: 'agent' | 'user' | 'tool' | 'workflow' | 'system';
  actorId?: string;
  summary: string;
  payload?: unknown;
  at?: string;
}): Promise<void> {
  const at = input.at || new Date().toISOString();
  await db.prepare(
    `insert or ignore into content_review_interactions (
      id, idempotency_key, group_id, job_id, artifact_id, parent_run_id, child_run_id,
      kind, actor_type, actor_id, summary, payload_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), input.idempotencyKey, input.groupId, input.jobId,
    input.artifactId || '', input.parentRunId || '', input.childRunId || '',
    input.kind, input.actorType, input.actorId || '', input.summary.slice(0, 2000),
    runtimeJson(input.payload || {}), at,
  ).run();
}

export async function listContentReviewInteractions(
  db: D1Database,
  groupId: string,
  jobId = '',
): Promise<ContentReviewInteraction[]> {
  const rows = await db.prepare(
    `select * from content_review_interactions
     where group_id = ? and (? = '' or job_id = ?)
     order by created_at asc, id asc`,
  ).bind(groupId, jobId, jobId).all<Record<string, unknown>>();
  for (const row of rows.results ?? []) row.payload_json = JSON.stringify(await readRuntimeJson(db, String(row.payload_json || '{}')));
  return (rows.results || []).map((row) => ({
    id: String(row.id), group_id: String(row.group_id), job_id: String(row.job_id),
    artifact_id: String(row.artifact_id || ''), parent_run_id: String(row.parent_run_id || ''),
    child_run_id: String(row.child_run_id || ''), kind: String(row.kind), actor_type: String(row.actor_type),
    actor_id: String(row.actor_id || ''), summary: String(row.summary || ''),
    payload: parseJson(String(row.payload_json || '{}'), {}), created_at: String(row.created_at),
  }));
}

function runSummary(run: AgentRun): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(run.summary_json, {});
}

function contextChunks(value: string, size = 3800): string[] {
  const text = value.trim();
  if (!text) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) chunks.push(text.slice(offset, offset + size));
  return chunks;
}

export function articleVersionsForContentReview(
  versions: ArticleVersion[],
): ContentReviewTask['versions'] {
  return versions.map((version) => ({
    locale: version.locale,
    slug: version.slug,
    title: version.title,
    excerpt: version.excerpt,
    meta_description: version.meta_description,
    image_url: version.image_url,
    image_alt: version.image_alt,
    content: version.content,
  }));
}

export function contentGroupStartupContext(
  group: ContentGroupRow,
  site: Record<string, unknown>,
  items: Record<string, unknown>[],
  runId: string,
  currentRunStartedAt?: string,
): Record<string, unknown> {
  const siteContext = {
    id: site.id,
    name: site.name,
    domain: site.domain,
    root_domain: site.root_domain,
    source_locale: site.source_locale,
    hub_path: site.hub_path,
    translate_locales_json: site.translate_locales_json,
    min_words: site.min_words,
    product_brief: site.product_brief,
  };
  return {
    group: {
      id: group.id,
      decision_group_id: group.decision_group_id,
      total_items: group.total_items,
      ready_items: group.ready_items,
      failed_items: group.failed_items,
      review_round: group.review_round,
    },
    site: siteContext,
    items,
    language_assignment: 'Each saved job owns its source_locale and translate_locales_json. Site language settings are configuration, not a request to create translations.',
    ...(currentRunStartedAt !== undefined ? { group_record: {
      management_run_id: group.parent_run_id,
      status: group.status,
      error: group.error,
      updated_at: group.updated_at,
    } } : { prior_execution: {
      parent_run_id: group.parent_run_id,
      status: group.status,
      error: group.error,
      recorded_at: group.updated_at,
      historical: Boolean(group.parent_run_id && group.parent_run_id !== runId),
    } }),
    current_run: { id: runId, ...(currentRunStartedAt !== undefined ? { started_at: currentRunStartedAt } : {}) },
  };
}

export async function loadContentProductionContext(
  db: D1Database,
  site: Record<string, unknown>,
  run: AgentRun,
): Promise<ContextSourceValue[]> {
  const summary = runSummary(run);
  const groupId = String(summary.group_id || '');
  const group = await db.prepare(
    'select * from content_production_groups where id = ? and workspace_id = ? and site_id = ?',
  ).bind(groupId, run.workspace_id, run.site_id).first<ContentGroupRow>();
  if (!group) throw new Error('Content production group was not found');
  const rows = await db.prepare(
    `select i.*, j.id as job_id, j.status as job_status, j.current_artifact_id, j.source_locale, j.translate_locales_json,
            ${run.definition_version >= 22 ? 'j.created_at as job_created_at,j.published_at,' : ''}
            t.title_hint, t.category, t.primary_keyword
     from topic_decision_items i
     join jobs j on j.decision_item_id = i.id
     join topics t on t.id = j.topic_id
     where i.result_id = ? and j.production_group_id = ?
     order by i.sort_order asc`,
  ).bind(group.decision_group_id, group.id).all<Record<string, unknown>>();
  return [{
    sourceId: 'content_group', version: `${group.id}:${group.updated_at}`, capturedAt: group.updated_at, priority: 100,
    value: contentGroupStartupContext(group, site, rows.results ?? [], run.id, run.definition_version >= 22 ? run.created_at : undefined),
  }];
}

/**
 * Byte caps for the single-source contexts of the content Agents.
 *
 * Each is below its Agent's `contextBudgetBytes`, so `assembleContext` can never
 * drop the one required source and fail the Run. These Agents carry whole
 * article bodies, so the ceiling is reached by a long enough article, a high
 * enough `min_words`, or enough locales — not by anything unusual.
 */
export const CONTENT_CONTEXT_BYTE_CAPS = {
  // content_production budget 130_000
  content_group: 120_000,
  // article_production budget 80_000
  article_task: 74_000,
  // content_review budget 210_000
  content_review_task: 200_000,
} as const;

export async function loadArticleProductionContext(
  db: D1Database,
  site: Record<string, unknown>,
  run: AgentRun,
): Promise<ContextSourceValue[]> {
  const summary = runSummary(run);
  const groupId = String(summary.group_id || '');
  const jobId = String(summary.job_id || '');
  const row = await db.prepare(
    `select j.id as job_id, j.translate_locales_json, j.source_locale,
            coalesce((select a.id from content_artifacts a where a.job_id = j.id order by a.attempt desc limit 1), j.current_artifact_id, '') as previous_artifact_id,
            j.plan_json, t.title_hint, t.category, t.primary_keyword, t.topic_key,
            i.id as decision_item_id, i.locale, i.search_intent, i.group_role, i.strategy_version_id,
            i.rationale, i.hypothesis, i.evidence_json, i.relationship_to_existing, i.risk,
            r.id as decision_group_id, r.group_goal, r.group_hypothesis, r.rationale as group_rationale
     from jobs j
     join topics t on t.id = j.topic_id
     join topic_decision_items i on i.id = j.decision_item_id
     join topic_decision_results r on r.id = i.result_id
     where j.id = ? and j.production_group_id = ? and r.site_id = ?`,
  ).bind(jobId, groupId, run.site_id).first<Record<string, unknown>>();
  if (!row) throw new Error('Article production task was not found');
  const [modules, strategy, published, siblings] = await Promise.all([
    listBusinessModules(db, run.site_id),
    strategyVersionContext(db, String(row.strategy_version_id || '')),
    // Real live articles, so an internal link can be copied rather than composed.
    db.prepare(
      "select id, versions_json from jobs where site_id = ? and status = 'published' order by published_at desc limit 40",
    ).bind(run.site_id).all<Record<string, unknown>>(),
    // Siblings being written right now. They have no slug yet, which is why the
    // writer is given their job ids and not URLs.
    db.prepare(
      `select j.id as job_id, i.title_direction, i.primary_keyword, i.locale
       from jobs j join topic_decision_items i on i.id = j.decision_item_id
       where j.production_group_id = ? and j.id <> ?`,
    ).bind(groupId, jobId).all<Record<string, unknown>>(),
  ]);
  const linkFacts = siteLinkFacts(site);
  const publishedArticles = linkableArticles(published.results ?? [], linkFacts.blog_origin);
  const sourceLocale = String(row.source_locale || row.locale || site.source_locale || 'en');
  const translated = parseJson<string[]>(String(row.translate_locales_json || '[]'), []);
  const task: ArticleTask = {
    group_id: groupId,
    decision_group_id: String(row.decision_group_id),
    job_id: String(row.job_id),
    decision_item_id: String(row.decision_item_id),
    source_locale: sourceLocale,
    locales: [...new Set([sourceLocale, ...translated])],
    ...linkFacts,
    published_articles: publishedArticles,
    group_articles: (siblings.results ?? []).map((item) => ({
      job_id: String(item.job_id),
      title_direction: String(item.title_direction || ''),
      primary_keyword: String(item.primary_keyword || ''),
      locale: String(item.locale || ''),
    })),
    topic: {
      title_hint: row.title_hint, category: row.category, primary_keyword: row.primary_keyword,
      topic_key: row.topic_key, locale: row.locale, search_intent: row.search_intent,
      group_role: row.group_role, rationale: row.rationale, hypothesis: row.hypothesis,
      relationship_to_existing: row.relationship_to_existing, risk: row.risk,
    },
    group: { goal: row.group_goal, hypothesis: row.group_hypothesis, rationale: row.group_rationale },
    business_context: contextChunks(buildBusinessContext(modules)),
    strategy_context: contextChunks(strategy),
    evidence: parseJson<unknown[]>(String(row.evidence_json || '[]'), []),
    attempt: Math.max(1, Number(summary.attempt || 1)),
    editorial_brief: String(summary.editorial_brief || ''),
    parent_feedback: Array.isArray(summary.parent_feedback) ? summary.parent_feedback.map(String).slice(0, 12) : [],
    previous_artifact_id: String(row.previous_artifact_id || ''),
  };
  if (task.previous_artifact_id) {
    const previous = await db.prepare('select id,versions_json,seo_contract_json from content_artifacts where id=? and job_id=? and group_id=?')
      .bind(task.previous_artifact_id, jobId, groupId).first<{ id: string; versions_json: string; seo_contract_json: string }>();
    if (previous) {
      task.previous_candidate = { artifact_id: previous.id, versions: parseJson<ArticleVersion[]>(previous.versions_json, []),
        seo_contract: await readRuntimeJson(db, previous.seo_contract_json) };
      // A parent may have selected an older published page outside the default latest-40 view.
      const targets = task.previous_candidate.seo_contract.internal_link_targets as Array<{ status: string; job_id: string; locale: string; title: string; href: string; url?: string }> | undefined;
      for (const target of targets || []) if (target.status === 'published' && !task.published_articles.some(a => a.job_id === target.job_id && a.locale === target.locale)) {
        task.published_articles.push({ job_id: target.job_id, locale: target.locale, title: target.title, url: target.url || target.href });
      }
    }
  }
  return [{
    sourceId: 'article_task', version: `${task.decision_item_id}:${task.attempt}`, capturedAt: '', priority: 100,
    value: task,
  }];
}

export async function loadContentReviewContext(
  db: D1Database,
  site: Record<string, unknown>,
  run: AgentRun,
): Promise<ContextSourceValue[]> {
  const summary = runSummary(run);
  const groupId = String(summary.group_id || '');
  const jobId = String(summary.job_id || '');
  const artifactId = String(summary.artifact_id || run.agent_instance_id || '');
  if (!groupId || !jobId || !artifactId) {
    throw new Error('Content review Run identity is incomplete');
  }
  const row = await db.prepare(
    `select a.id as artifact_id, a.group_id, a.job_id, a.attempt, a.status as artifact_status,
            a.child_run_id, a.versions_json, a.seo_contract_json, a.qa_report_json,
            j.current_artifact_id, t.title_hint, t.category, t.primary_keyword, t.topic_key,
            i.locale, i.search_intent, i.group_role, i.title_direction, i.strategy_version_id,
            i.rationale, i.hypothesis, i.evidence_json, i.relationship_to_existing, i.risk,
            r.group_goal, r.group_hypothesis, r.rationale as group_rationale
     from content_artifacts a
     join jobs j on j.id = a.job_id
     join topics t on t.id = j.topic_id
     join topic_decision_items i on i.id = a.decision_item_id
     join topic_decision_results r on r.id = i.result_id
     join content_production_groups g on g.id = a.group_id
     where a.id = ? and a.job_id = ? and a.group_id = ?
       and g.workspace_id = ? and g.site_id = ?`,
  ).bind(artifactId, jobId, groupId, run.workspace_id, run.site_id).first<Record<string, unknown>>();
  if (!row) throw new Error('Content review artifact was not found');
  if (String(row.artifact_status) !== 'candidate') throw new Error('Content review artifact is no longer a candidate');
  const latest = await db.prepare(
    'select id from content_artifacts where job_id = ? order by attempt desc limit 1',
  ).bind(jobId).first<{ id: string }>();
  if (latest?.id !== artifactId) throw new Error('Content review artifact is no longer the latest version');
  const [modules, strategy, siblings] = await Promise.all([
    listBusinessModules(db, run.site_id),
    strategyVersionContext(db, String(row.strategy_version_id || '')),
    db.prepare(
      `select a.job_id, a.status as artifact_status, a.parent_review_json,
              i.group_role, i.primary_keyword, i.title_direction, a.versions_json
       from content_artifacts a
       join topic_decision_items i on i.id = a.decision_item_id
       where a.group_id = ? and a.job_id <> ?
         and a.attempt = (select max(a2.attempt) from content_artifacts a2 where a2.job_id = a.job_id)
       order by i.sort_order asc`,
    ).bind(groupId, jobId).all<Record<string, unknown>>(),
  ]);
  for (const sibling of siblings.results ?? []) sibling.parent_review_json = JSON.stringify(await readRuntimeJson(db, String(sibling.parent_review_json || '{}')));
  const versions = articleVersionsForContentReview(
    parseJson<ArticleVersion[]>(String(row.versions_json || '[]'), []),
  );
  if (!versions.length || versions.some((version) => !contentReviewBody(version).trim())) {
    throw new Error('Content review artifact does not contain complete article versions');
  }
  const siblingDrafts = (siblings.results || []).map((sibling) => ({ job_id: String(sibling.job_id), title_direction: String(sibling.title_direction || ''),
    versions: parseJson<ArticleVersion[]>(String(sibling.versions_json || '[]'), []).map((version) => ({ locale: version.locale, title: version.title, excerpt: version.excerpt })) }));
  const plannedSiblings = await db.prepare(
    `select j.id as job_id, i.title_direction from jobs j join topic_decision_items i on i.id = j.decision_item_id where j.production_group_id = ? and j.id <> ?`,
  ).bind(groupId, jobId).all<{ job_id: string; title_direction: string }>();
  for (const planned of plannedSiblings.results || []) {
    if (!siblingDrafts.some((item) => item.job_id === planned.job_id)) siblingDrafts.push({ job_id: planned.job_id, title_direction: planned.title_direction, versions: [] });
  }
  const internalLinks = await describeContentInternalLinks(db, { siteId: run.site_id, policy: contentLinkPolicy(site),
    versions: parseJson<ArticleVersion[]>(String(row.versions_json || '[]'), []), siblings: siblingDrafts });
  const task: ContentReviewTask = {
    internal_links: internalLinks,
    group_id: groupId,
    job_id: jobId,
    artifact_id: artifactId,
    author_child_run_id: String(row.child_run_id || ''),
    parent_run_id: run.parent_run_id,
    attempt: Number(row.attempt || 0),
    task: {
      title_hint: row.title_hint, title_direction: row.title_direction, category: row.category,
      primary_keyword: row.primary_keyword, topic_key: row.topic_key, locale: row.locale,
      search_intent: row.search_intent, group_role: row.group_role,
      rationale: row.rationale, hypothesis: row.hypothesis,
      relationship_to_existing: row.relationship_to_existing, risk: row.risk,
    },
    group_objective: {
      goal: row.group_goal, hypothesis: row.group_hypothesis, rationale: row.group_rationale,
    },
    business_context: contextChunks(buildBusinessContext(modules)),
    strategy_context: contextChunks(strategy),
    evidence: parseJson<unknown[]>(String(row.evidence_json || '[]'), []),
    seo_contract: await readRuntimeJson(db, String(row.seo_contract_json || '{}')),
    deterministic_qa: parseJson(String(row.qa_report_json || '{}'), {}),
    versions,
    sibling_context: (siblings.results || []).map((sibling) => ({
      job_id: sibling.job_id,
      group_role: sibling.group_role,
      primary_keyword: sibling.primary_keyword,
      artifact_status: sibling.artifact_status,
      parent_review: parseJson(String(sibling.parent_review_json || '{}'), {}),
      versions: parseJson<ArticleVersion[]>(String(sibling.versions_json || '[]'), []).map((version) => ({
        locale: version.locale, title: version.title, excerpt: version.excerpt,
      })),
    })),
  };
  return [{
    sourceId: 'content_review_task',
    version: `${artifactId}:${task.attempt}`,
    capturedAt: '',
    priority: 100,
    value: task,
  }];
}

/** The writer's gate: the site facts and article names the author was given. */
function submissionQa(task: ArticleTask, versions: ArticleVersion[]): QaReport {
  return runQa({ versions, locales: task.locales,
    ...articleLinkQaInput(task, task.published_articles, task.group_articles.map((article) => article.job_id)) });
}

/**
 * The human approval gate applies the writer's rules to what is live now: every
 * published article and this group's siblings. It accepts every link the writer's
 * gate accepted, and still rejects one whose target has since gone away.
 */
export async function publicationQa(db: D1Database, site: Record<string, unknown>,
  job: { id: string; site_id: string; production_group_id?: string | null }, versions: ArticleVersion[], locales: string[]): Promise<QaReport> {
  const facts = siteLinkFacts(site);
  const [published, siblings] = await Promise.all([
    db.prepare("select id, versions_json from jobs where site_id = ? and status = 'published' and id <> ?")
      .bind(job.site_id, job.id).all<{ id: string; versions_json: string }>(),
    job.production_group_id
      ? db.prepare('select id from jobs where production_group_id = ? and site_id = ? and id <> ?')
        .bind(job.production_group_id, job.site_id, job.id).all<{ id: string }>()
      : Promise.resolve({ results: [] as Array<{ id: string }> }),
  ]);
  return runQa({ versions, locales,
    ...articleLinkQaInput(facts, linkableArticles(published.results ?? [], facts.blog_origin), (siblings.results ?? []).map((row) => row.id)) });
}

export type ArticleSubmissionFeedback = {
  accepted: boolean;
  expected_locales: string[];
  received_locales: string[];
  issues: SubmissionIssue[];
};

export function validateArticleSubmission(task: ArticleTask, bundle: ArticleBundle): ArticleSubmissionFeedback {
  const expected = task.locales;
  const received = bundle.versions.map((item) => item.locale);
  const issues: SubmissionIssue[] = [];
  if (bundle.versions.length !== expected.length) {
    issues.push({
      code: 'locale_count_mismatch', severity: 'format',
      message: `Expected exactly ${expected.length} locale version(s) (${expected.join(', ')}); received ${received.length} (${received.join(', ')})`,
    });
  }
  if (new Set(received).size !== received.length || expected.some((locale) => !received.includes(locale))) {
    issues.push({
      code: 'locale_identity_mismatch', severity: 'format',
      message: `Expected locale identities [${expected.join(', ')}]; received [${received.join(', ')}]`,
    });
  }
  if (!bundle.seo_contract.reader_value.trim() || !bundle.seo_contract.direct_answer.trim()) {
    issues.push({ code: 'missing_value_contract', severity: 'format', message: 'The reader-value and direct-answer contract must both be explicit' });
  }
  // Deterministic QA is structural: closing a fence or adding the hub link is a
  // targeted edit, but it is an edit to the prose the Agent wrote, so it is
  // reported alongside the identity checks rather than repaired blind.
  issues.push(...submissionQa(task, bundle.versions)
    .issues.map((issue): SubmissionIssue => ({ ...issue, severity: 'domain' })));
  return { accepted: issues.length === 0, expected_locales: [...expected], received_locales: received, issues };
}

/** extras carries delivery records such as the author's fresh self-check and confirmed link spots. */
export async function persistArticleArtifact(env: RuntimeAgentEnv, runId: string, task: ArticleTask, bundle: ArticleBundle, operationId = `legacy:${runId}`, editorial?: EditorialCandidate, extras: Record<string, unknown> = {}): Promise<{
  artifactId: string; jobId: string; attempt: number; localeCount: number; qa: QaReport;
}> {
  const replay = await env.DB.prepare(
    'select id, job_id, attempt, versions_json, qa_report_json from content_artifacts where submission_operation_id = ?',
  ).bind(operationId).first<{ id: string; job_id: string; attempt: number; versions_json: string; qa_report_json: string }>();
  if (replay) {
    await recordContentReviewInteraction(env.DB, {
      idempotencyKey: `artifact-submitted:${replay.id}`, groupId:task.group_id, jobId:replay.job_id,
      artifactId:replay.id,childRunId:runId,kind:'child_submitted',actorType:'agent',actorId:'article_production',
      summary:`The article sub-agent submitted draft ${replay.attempt} candidate content.`,
      payload:{attempt:replay.attempt,locale_count:parseJson<ArticleVersion[]>(replay.versions_json,[]).length,qa:parseJson(replay.qa_report_json,{})},
    });
    return {
      artifactId: replay.id,
      jobId: replay.job_id,
      attempt: Number(replay.attempt),
      localeCount: parseJson<ArticleVersion[]>(replay.versions_json, []).length,
      qa: parseJson<QaReport>(replay.qa_report_json, { ok: false, issues: [] }),
    };
  }
  const qa = submissionQa(task, bundle.versions);
  if (!qa.ok) throw contentConflict('Cannot persist an article bundle that has not passed submission validation');
  const artifactId = crypto.randomUUID();
  const at = new Date().toISOString();
  const inheritedTargets = task.previous_candidate?.seo_contract.internal_link_targets;
  const seoContract = {
    ...(editorial ? { ...Object.fromEntries(Object.entries(bundle.seo_contract).filter(([key]) => key !== 'factual_claims')), editorial } : bundle.seo_contract),
    ...(inheritedTargets ? { internal_link_targets: inheritedTargets } : {}),
    ...extras,
  };
  const inserted = await env.DB.batch([
    env.DB.prepare(
      `insert into content_artifacts (
        id, group_id, job_id, decision_item_id, child_run_id, submission_operation_id, attempt, status,
        versions_json, seo_contract_json, qa_report_json, parent_review_json,
        supersedes_artifact_id, created_at, updated_at
      ) select ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, '{}', ?, ?, ? where exists(select 1 from jobs where id=? and production_group_id=? and status not in ('publishing','published'))`,
    ).bind(
      artifactId, task.group_id, task.job_id, task.decision_item_id, runId, operationId, task.attempt,
      JSON.stringify(bundle.versions), await persistRuntimeJson(env.DB, seoContract), JSON.stringify(qa),
      task.previous_artifact_id, at, at, task.job_id, task.group_id,
    ),
    env.DB.prepare(
      `update jobs set status = 'drafting', child_run_id = ?, error = '', review_note = '', updated_at = ?
       where id = ? and production_group_id = ? and status not in ('publishing', 'published')`,
    ).bind(runId, at, task.job_id, task.group_id),
  ]);
  if (!inserted[0].meta.changes) throw contentConflict('Article job is no longer writable');
  await recordContentReviewInteraction(env.DB, {
    idempotencyKey: `artifact-submitted:${artifactId}`,
    groupId: task.group_id,
    jobId: task.job_id,
    artifactId,
    childRunId: runId,
    kind: 'child_submitted',
    actorType: 'agent',
    actorId: 'article_production',
    summary: `The article sub-agent submitted draft ${task.attempt} candidate content.`,
    payload: { attempt: task.attempt, locale_count: bundle.versions.length, qa },
    at,
  });
  return { artifactId, jobId: task.job_id, attempt: task.attempt, localeCount: bundle.versions.length, qa };
}

export async function applyContentReviewDecision(
  db: D1Database,
  reviewRunId: string,
  task: Pick<ContentReviewTask, 'group_id' | 'job_id' | 'artifact_id'>,
  decision: ContentReviewDecision,
): Promise<{ artifactId: string; jobId: string; decision: 'pass' | 'revise' }> {
  const [reviewRun, artifact, latest] = await Promise.all([
    db.prepare(
      `select id, workspace_id, site_id, agent_id, agent_instance_id, parent_run_id
       from agent_runs where id = ?`,
    ).bind(reviewRunId).first<Record<string, unknown>>(),
    db.prepare(
      `select a.*, g.workspace_id, g.site_id
       from content_artifacts a join content_production_groups g on g.id = a.group_id
       where a.id = ? and a.job_id = ? and a.group_id = ?`,
    ).bind(task.artifact_id, task.job_id, task.group_id).first<Record<string, unknown>>(),
    db.prepare(
      `select id from content_artifacts where job_id = ? and group_id = ?
       order by attempt desc limit 1`,
    ).bind(task.job_id, task.group_id).first<{ id: string }>(),
  ]);
  const assigned = await db.prepare(`select a.id,a.context_json from agent_task_assignments a join agent_tasks t on t.assignment_id=a.id where t.active_run_id=?`).bind(reviewRunId).first<{id:string;context_json:string}>();
  if (!reviewRun || reviewRun.agent_id !== 'content_review' || !assigned || (await readRuntimeJson<{artifact_id:string}>(db, assigned.context_json)).artifact_id !== task.artifact_id) {
    throw contentConflict('Content review Run does not own this artifact');
  }
  if (!artifact || artifact.workspace_id !== reviewRun.workspace_id || artifact.site_id !== reviewRun.site_id) {
    throw contentConflict('Content review artifact is outside the Run boundary');
  }
  const recorded = await readRuntimeJson<Record<string, unknown>>(db, String(artifact.parent_review_json || '{}'));
  if (
    String(recorded.review_run_id || '') === reviewRunId &&
    String(recorded.decision || '') === decision.decision &&
    String(artifact.status) === (decision.decision === 'pass' ? 'accepted' : 'rejected')
  ) {
    return { artifactId: task.artifact_id, jobId: task.job_id, decision: decision.decision };
  }
  if (latest?.id !== task.artifact_id || artifact.status !== 'candidate') {
    throw contentConflict('Content review artifact changed after this Run started; inspect and review the latest candidate instead');
  }
  const at = new Date().toISOString();
  const reviewRecord = { ...decision, review_run_id: reviewRunId };
  const reviewJson = await persistRuntimeJson(db, reviewRecord);
  const nextArtifactStatus = decision.decision === 'pass' ? 'accepted' : 'rejected';
  const feedback = decision.required_changes.join('; ');
  const statements = [
    db.prepare(
      `update content_artifacts set status = ?, parent_review_json = ?, updated_at = ?
       where id = ? and status = 'candidate' and id = (
         select a2.id from content_artifacts a2 where a2.job_id = ? and a2.group_id = ?
         order by a2.attempt desc limit 1
       ) and exists(select 1 from agent_tasks where active_run_id=? and assignment_id=?)`,
    ).bind(nextArtifactStatus, reviewJson, at, task.artifact_id, task.job_id, task.group_id, reviewRunId, assigned.id),
  ];
  if (decision.decision === 'pass') {
    statements.push(db.prepare(
      `update jobs set status = 'awaiting_review', current_artifact_id = ?, versions_json = ?, qa_report = ?,
         error = '', review_note = '', content_updated_at = ?, updated_at = ?
       where id = ? and production_group_id = ? and status not in ('publishing', 'published')
         and exists (select 1 from content_artifacts where id = ? and status = ? and parent_review_json = ?)`,
    ).bind(
      task.artifact_id, artifact.versions_json, artifact.qa_report_json, at, at,
      task.job_id, task.group_id, task.artifact_id, nextArtifactStatus, reviewJson,
    ));
  } else {
    statements.push(db.prepare(
      `update jobs set status = 'drafting', review_note = ?, error = '', updated_at = ?
       where id = ? and production_group_id = ? and status not in ('publishing', 'published')
         and exists (select 1 from content_artifacts where id = ? and status = ? and parent_review_json = ?)`,
    ).bind(feedback, at, task.job_id, task.group_id, task.artifact_id, nextArtifactStatus, reviewJson));
  }
  statements.push(
    db.prepare(
      `insert or ignore into content_review_interactions (
        id, idempotency_key, group_id, job_id, artifact_id, parent_run_id, child_run_id,
        kind, actor_type, actor_id, summary, payload_json, created_at
      ) select ?, ?, ?, ?, ?, ?, ?, ?, 'agent', 'content_review', ?, ?, ?
        where exists (select 1 from content_artifacts where id = ? and status = ? and parent_review_json = ?)`,
    ).bind(
      crypto.randomUUID(), `content-review:${reviewRunId}:${task.artifact_id}:${decision.decision}`,
      task.group_id, task.job_id, task.artifact_id, String(reviewRun.parent_run_id || ''),
      String(artifact.child_run_id || ''),
      decision.decision === 'pass' ? 'parent_accepted' : 'parent_revision_requested',
      decision.decision === 'pass'
        ? 'The parent Agent\'s isolated review Run approved it; this article has been pushed to pre-publish review.'
        : `The parent Agent's isolated review Run sent it back for revision: ${feedback || decision.value_assessment}`,
      reviewJson, at, task.artifact_id, nextArtifactStatus, reviewJson,
    ),
    db.prepare(
      `update content_production_groups set status = case
           when (select count(*) from jobs where production_group_id = ? and status not in ('awaiting_review', 'publishing', 'published')) = 0
             then 'awaiting_review'
           when exists (select 1 from agent_runs where id = ? and status in ('queued', 'running', 'waiting_for_approval', 'waiting_for_input'))
             then 'reviewing'
           else 'needs_attention'
         end,
         ready_items = (select count(*) from jobs where production_group_id = ? and status in ('awaiting_review', 'publishing', 'published')),
         failed_items = (select count(*) from jobs where production_group_id = ? and status in ('failed', 'publish_failed')),
         review_round = max(review_round, ?), review_json = ?,
         error = case
           when ? <> '' then ?
           when (select count(*) from jobs where production_group_id = ? and status not in ('awaiting_review', 'publishing', 'published')) > 0
             and not exists (select 1 from agent_runs where id = ? and status in ('queued', 'running', 'waiting_for_approval', 'waiting_for_input'))
             then ?
           else ''
         end,
         updated_at = ?
       where id = ?
         and exists (select 1 from content_artifacts where id = ? and status = ? and parent_review_json = ?)`,
    ).bind(
      task.group_id, String(reviewRun.parent_run_id || ''), task.group_id, task.group_id, Number(artifact.attempt || 0), reviewJson,
      decision.decision === 'revise' ? '1 article was sent back to the sub-agent by the parent Agent for revision.' : '',
      decision.decision === 'revise' ? '1 article was sent back to the sub-agent by the parent Agent for revision.' : '',
      task.group_id, String(reviewRun.parent_run_id || ''),
      'This article\'s review result has been saved; the parent Agent needs to continue handling the remaining articles.',
      at, task.group_id,
      task.artifact_id, nextArtifactStatus, reviewJson,
    ),
  );
  await db.batch(statements);
  const committed = await db.prepare(
    'select status, parent_review_json from content_artifacts where id = ?',
  ).bind(task.artifact_id).first<{ status: string; parent_review_json: string }>();
  if (committed?.status !== nextArtifactStatus || committed.parent_review_json !== reviewJson) {
    throw contentConflict('Content review artifact changed before this decision could be committed; inspect and review the latest candidate instead');
  }
  return { artifactId: task.artifact_id, jobId: task.job_id, decision: decision.decision };
}

export async function finalizeContentGroup(db: D1Database, groupId: string): Promise<void> {
  const unresolved = await db.prepare(
    `select count(*) as n from jobs
     where production_group_id = ? and status not in ('awaiting_review', 'publishing', 'published')`,
  ).bind(groupId).first<{ n: number }>();
  if (Number(unresolved?.n || 0) > 0) {
    throw contentConflict('Every article must be individually accepted for human review before the group can close');
  }
  const at = new Date().toISOString();
  await db.prepare(
    `update content_production_groups set status = 'awaiting_review', ready_items = total_items,
       failed_items = 0, error = '', updated_at = ? where id = ? and not exists(select 1 from jobs where production_group_id=? and status not in ('awaiting_review','publishing','published'))`,
  ).bind(at, groupId, groupId).run();
}

export async function markContentGroupAttention(db: D1Database, groupId: string, error: string): Promise<void> {
  const at = new Date().toISOString();
  const counts = await db.prepare(
    `select
       sum(case when status in ('awaiting_review', 'publishing', 'published') then 1 else 0 end) as ready,
       sum(case when status in ('failed', 'publish_failed') then 1 else 0 end) as failed
     from jobs where production_group_id = ?`,
  ).bind(groupId).first<{ ready: number; failed: number }>();
  await db.prepare(
    `update content_production_groups set status = 'needs_attention', ready_items = ?,
       failed_items = ?, error = ?, updated_at = ? where id = ?`,
  ).bind(Number(counts?.ready || 0), Number(counts?.failed || 0), error.slice(0, 1000), at, groupId).run();
}

export async function contentProductionPayload(db: D1Database, workspaceId: string, siteId: string, groupId = '') {
  const groups = await db.prepare(
    `select g.*, r.group_goal, r.group_hypothesis,
            pr.status as parent_run_status, pr.phase as parent_run_phase,
            pr.error as parent_run_error, pr.started_at as parent_run_started_at,
            pr.updated_at as parent_run_updated_at,
            (select e.kind from agent_events e where e.run_id = g.parent_run_id order by e.seq desc limit 1) as latest_event_kind,
            (select e.phase from agent_events e where e.run_id = g.parent_run_id order by e.seq desc limit 1) as latest_event_phase,
            (select e.payload_json from agent_events e where e.run_id = g.parent_run_id order by e.seq desc limit 1) as latest_event_payload_json,
            (select e.created_at from agent_events e where e.run_id = g.parent_run_id order by e.seq desc limit 1) as latest_event_at,
            coalesce(
              (select ma.model from agent_model_attempts ma where ma.run_id = g.parent_run_id order by ma.decision_turn desc, ma.attempt desc limit 1),
              (select mc.model from agent_model_calls mc where mc.run_id = g.parent_run_id order by mc.created_at desc limit 1)
            ) as latest_model,
            coalesce(
              (select ma.status from agent_model_attempts ma where ma.run_id = g.parent_run_id order by ma.decision_turn desc, ma.attempt desc limit 1),
              (select mc.status from agent_model_calls mc where mc.run_id = g.parent_run_id order by mc.created_at desc limit 1)
            ) as latest_model_status,
            coalesce(
              (select ma.error from agent_model_attempts ma where ma.run_id = g.parent_run_id order by ma.decision_turn desc, ma.attempt desc limit 1),
              (select mc.error from agent_model_calls mc where mc.run_id = g.parent_run_id order by mc.created_at desc limit 1)
            ) as latest_model_error,
            (select json_extract(o.action_json, '$.name') from agent_task_operations o join agent_tasks t on t.id = o.task_id
              where t.active_run_id = g.parent_run_id order by o.turn desc limit 1) as parent_last_action,
            (select o.status from agent_task_operations o join agent_tasks t on t.id = o.task_id
              where t.active_run_id = g.parent_run_id order by o.turn desc limit 1) as parent_last_action_status,
            (select count(distinct a.job_id) from content_artifacts a where a.group_id = g.id) as produced_items,
            ((select count(*) from jobs j join agent_runs ar on ar.id = j.child_run_id
              where j.production_group_id = g.id and ar.status in ('queued', 'running')) +
             (select count(*) from agent_runs rr
              where rr.workspace_id = g.workspace_id and rr.site_id = g.site_id
                and rr.agent_id = 'content_review' and rr.status in ('queued', 'running')
                and rr.agent_instance_id in (select a.id from content_artifacts a where a.group_id = g.id))) as active_items
     from content_production_groups g
     join topic_decision_results r on r.id = g.decision_group_id
     left join agent_runs pr on pr.id = g.parent_run_id
       and pr.workspace_id = g.workspace_id and pr.site_id = g.site_id and pr.agent_id = 'content_production'
     where g.workspace_id = ? and g.site_id = ? and (? = '' or g.id = ?)
     order by g.created_at desc limit 30`,
  ).bind(workspaceId, siteId, groupId, groupId).all<Record<string, unknown>>();
  const children = await db.prepare(
    `select g.id as group_id, j.id as job_id, j.status as job_status, j.current_artifact_id, j.review_note,
            i.id as decision_item_id, i.title_direction, i.primary_keyword, i.group_role, i.sort_order,
            a.id as artifact_id, a.attempt, a.status as artifact_status, a.parent_review_json,
            ar.id as child_run_id, ar.status as child_run_status, ar.phase as child_run_phase,
            ar.error as child_run_error, ar.output_json as child_run_output_json,
            (select json_extract(o.action_json, '$.name') from agent_task_operations o join agent_tasks t on t.id = o.task_id
              where t.active_run_id = j.child_run_id order by o.turn desc limit 1) as child_last_action,
            (select o.status from agent_task_operations o join agent_tasks t on t.id = o.task_id
              where t.active_run_id = j.child_run_id order by o.turn desc limit 1) as child_last_action_status,
            rr.id as review_run_id, rr.status as review_run_status, rr.phase as review_run_phase,
            rr.error as review_run_error, rr.output_json as review_run_output_json
     from content_production_groups g
     join jobs j on j.production_group_id = g.id
     join topic_decision_items i on i.id = j.decision_item_id
     left join content_artifacts a on a.id = (
       select a2.id from content_artifacts a2 where a2.job_id = j.id order by a2.attempt desc limit 1
     )
     left join agent_runs ar on ar.id = j.child_run_id
     left join agent_runs rr on rr.id = (
       select rr2.id from agent_runs rr2
       where rr2.workspace_id = g.workspace_id and rr2.site_id = g.site_id
         and rr2.agent_id = 'content_review' and rr2.agent_instance_id = j.decision_item_id
       order by rr2.created_at desc limit 1
     )
     where g.workspace_id = ? and g.site_id = ? and (? = '' or g.id = ?)
     order by g.created_at desc, i.sort_order asc`,
  ).bind(workspaceId, siteId, groupId, groupId).all<Record<string, unknown>>();
  const byGroup = new Map<string, Record<string, unknown>[]>();
  for (const child of children.results ?? []) {
    const key = String(child.group_id);
    byGroup.set(key, [...(byGroup.get(key) || []), {
      ...child,
      parent_review: await readRuntimeJson(db, String(child.parent_review_json || '{}')),
      child_run_output: parseJson(String(child.child_run_output_json || '{}'), {}),
      review_run_output: parseJson(String(child.review_run_output_json || '{}'), {}),
    }]);
  }
  for (const group of groups.results ?? []) group.review_json = JSON.stringify(await readRuntimeJson(db, String(group.review_json || '{}')));
  return {
    groups: (groups.results ?? []).map((group) => {
      const { latest_event_payload_json: latestEventPayloadJson, ...publicGroup } = group;
      return {
        ...publicGroup,
        review: parseJson(String(group.review_json || '{}'), {}),
        latest_event_payload: parseJson(String(latestEventPayloadJson || '{}'), {}),
        items: byGroup.get(String(group.id)) || [],
      };
    }),
  };
}

export async function contentProductionGroupPayload(
  db: D1Database,
  workspaceId: string,
  siteId: string,
  groupId: string,
) {
  const payload = await contentProductionPayload(db, workspaceId, siteId, groupId);
  const group = (payload.groups as Array<Record<string, unknown>>).find((item) => String(item.id) === groupId);
  if (!group) throw new Error('Content production group was not found');
  // Detail-only: the latest candidate's author self-check and per-locale internal link counts.
  const site = await db.prepare('select domain, domain_status, product_origin, hub_path, hub_urls_json from sites where workspace_id = ? and id = ?')
    .bind(workspaceId, siteId).first<Record<string, unknown>>();
  const linkPolicy = contentLinkPolicy(site || {});
  const latestCandidates = await db.prepare(`select a.job_id, a.versions_json, a.seo_contract_json from content_artifacts a
    where a.group_id = ? and a.attempt = (select max(a2.attempt) from content_artifacts a2 where a2.job_id = a.job_id)`)
    .bind(groupId).all<{ job_id: string; versions_json: string; seo_contract_json: string }>();
  const candidateFacts = new Map<string, { self_check: { summary: string; findings: number; declined: number } | null; internal_link_counts: Array<{ locale: string; internal_links: number }> }>();
  for (const candidate of latestCandidates.results || []) {
    const contract = await readRuntimeJson<{ self_check?: { summary: string; findings: unknown[]; declined_findings: unknown[] } }>(db, String(candidate.seo_contract_json || '{}'));
    candidateFacts.set(candidate.job_id, {
      self_check: contract.self_check ? { summary: contract.self_check.summary, findings: contract.self_check.findings.length, declined: contract.self_check.declined_findings.length } : null,
      internal_link_counts: contentLinkCounts(parseJson<ArticleVersion[]>(candidate.versions_json, []), linkPolicy),
    });
  }
  const [interactions, artifacts, modelAttempts] = await Promise.all([
    listContentReviewInteractions(db, groupId),
    db.prepare(
      `select id, group_id, job_id, child_run_id, attempt, status, parent_review_json,
              supersedes_artifact_id, created_at, updated_at
       from content_artifacts where group_id = ? order by created_at asc, attempt asc`,
    ).bind(groupId).all<Record<string, unknown>>(),
    group.parent_run_id ? listRuntimeModelTrace(db, String(group.parent_run_id)) : Promise.resolve([]),
  ]);
  const interactionsByJob = new Map<string, ContentReviewInteraction[]>();
  for (const interaction of interactions) {
    interactionsByJob.set(interaction.job_id, [...(interactionsByJob.get(interaction.job_id) || []), interaction]);
  }
  const artifactsByJob = new Map<string, Record<string, unknown>[]>();
  for (const artifact of artifacts.results || []) {
    const jobId = String(artifact.job_id);
    const parentReview = await readRuntimeJson<Record<string, unknown>>(db, String(artifact.parent_review_json || '{}'));
    artifactsByJob.set(jobId, [...(artifactsByJob.get(jobId) || []), {
      ...artifact,
      parent_review: parentReview,
      parent_review_json: undefined,
    }]);
    const timeline = interactionsByJob.get(jobId) || [];
    if (!timeline.some((item) => item.kind === 'child_submitted' && item.artifact_id === String(artifact.id))) {
      timeline.push({
        id: `artifact:${artifact.id}`, group_id: groupId, job_id: jobId,
        artifact_id: String(artifact.id), parent_run_id: '', child_run_id: String(artifact.child_run_id || ''),
        kind: 'child_submitted', actor_type: 'agent', actor_id: 'article_production',
        summary: `The article sub-agent submitted draft ${Number(artifact.attempt || 0)} candidate content.`,
        payload: { attempt: Number(artifact.attempt || 0), recovered_from_artifact: true },
        created_at: String(artifact.created_at),
      });
    }
    const decision = String(parentReview.decision || '');
    if (decision && !timeline.some((item) => item.artifact_id === String(artifact.id) && item.kind.startsWith('parent_'))) {
      const required = Array.isArray(parentReview.required_changes) ? parentReview.required_changes.map(String) : [];
      timeline.push({
        id: `parent-review:${artifact.id}`, group_id: groupId, job_id: jobId,
        artifact_id: String(artifact.id), parent_run_id: '', child_run_id: String(artifact.child_run_id || ''),
        kind: decision === 'pass' ? 'parent_accepted' : 'parent_revision_requested',
        actor_type: 'agent', actor_id: 'content_production',
        summary: decision === 'pass'
          ? 'The parent Agent approved it; this article has been pushed to pre-publish review.'
          : `The parent Agent sent it back for revision: ${required.join('; ') || String(parentReview.value_assessment || '')}`,
        payload: parentReview,
        created_at: String(artifact.updated_at || artifact.created_at),
      });
    }
    timeline.sort((a, b) => a.created_at.localeCompare(b.created_at));
    interactionsByJob.set(jobId, timeline);
  }
  return {
    group: {
      ...group,
      model_attempts: modelAttempts,
      items: (group.items as Array<Record<string, unknown>>).map((item) => ({
        ...item,
        self_check: candidateFacts.get(String(item.job_id))?.self_check || null,
        internal_link_counts: candidateFacts.get(String(item.job_id))?.internal_link_counts || [],
        interactions: interactionsByJob.get(String(item.job_id)) || [],
        artifacts: artifactsByJob.get(String(item.job_id)) || [],
      })),
    },
  };
}

/** Independent editorial groups have independent execution instances. */
export function contentGroupInstance(groupId: string): string {
  if (!groupId) throw new Error('Content production requires a saved group');
  return `content:${encodeURIComponent(groupId).replace(/-/g, '%2D')}`;
}
