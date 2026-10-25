import { topicDeliveryStatements } from '../learning/delivery';
import type { TaskSubject } from './task-subjects';
import { type TopicScope } from './topic-scope';
import { taskForRun } from './task-store';
import { taskExecutionView } from './task-recovery';
import type { D1Database } from '@cloudflare/workers-types';
import { isoNow, newId } from '../db';
import type { AgentRun } from './protocol';
import { runtimeJson } from './protocol';
import { listAgentEvents } from './store';
import type { TopicDecisionOutput } from './topic-decision-contract';
import { listRuntimeModelTrace } from './observability';

export type TopicDecisionResultRow = {
  id: string;
  workspace_id: string;
  site_id: string;
  run_id: string;
  strategy_version_id: string | null;
  scope_locale?: string | null;
  strategy_version: number;
  decision_type: 'topic_group' | 'needs_research';
  status: 'draft' | 'rejected' | 'handed_off' | 'research_needed';
  group_goal: string;
  rationale: string;
  group_hypothesis: string;
  expected_signals_json: string;
  risks_json: string;
  unknowns_json: string;
  previous_group_relationship: string;
  research_request_json: string;
  web_evidence_json: string;
  requested_count: number;
  locales_json: string;
  language_decisions_json: string;
  reviewed_by: string;
  review_note: string;
  reviewed_at: string;
  review_operation_id?: string;
  created_at: string;
  updated_at: string;
};

export type TopicDecisionItemRow = {
  id: string;
  result_id: string;
  library_keyword_id?: string;
  strategy_keyword_id: string;
  keyword_id: string;
  topic_key: string;
  title_direction: string;
  primary_keyword: string;
  content_type: string;
  locale: string;
  strategy_version_id: string | null;
  strategy_version: number;
  search_intent: string;
  group_role: string;
  rationale: string;
  hypothesis: string;
  evidence_json: string;
  relationship_to_existing: string;
  risk: string;
  sort_order: number;
  topic_id: string | null;
  job_id: string | null;
  created_at: string;
};

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value || '') as T; } catch { return fallback; }
}

export async function persistTopicDecisionResult(input: {
  db: D1Database;
  workspaceId: string;
  siteId: string;
  runId: string;
  strategyVersionId: string | null;
  scope: TopicScope;
  strategyVersion: number;
  requestedCount: number;
  locales: string[];
  output: TopicDecisionOutput;
  webEvidence: unknown[];
  searchUsed: boolean;
  decisionTurns: number;
  languageDecisions?: unknown[];
  operationId?: string;
  captureDelivery?: boolean;
  strategyByLocale?: Record<string, { id: string | null; version: number }>;
}): Promise<{ id: string; decision: string; status: string; item_count: number }> {
  const replay = await input.db.prepare('select * from topic_decision_results where submission_operation_id = ?')
    .bind(input.operationId || `legacy:${input.runId}`).first<TopicDecisionResultRow>();
  if (replay) {
    const count = await input.db.prepare('select count(*) as n from topic_decision_items where result_id = ?')
      .bind(replay.id).first<{ n: number }>();
    return { id: replay.id, decision: replay.decision_type, status: replay.status, item_count: Number(count?.n || 0) };
  }
  if (input.locales.length !== 1 || input.locales[0] !== input.scope.locale ||
    input.output.group?.items.some(item => item.locale !== input.scope.locale)) {
    throw new Error('Topic group items must belong to the saved language');
  }
  const resultId = newId();
  const at = isoNow();
  const group = input.output.group;
  if (input.output.decision_type === 'defer') return { id: '', decision: 'defer', status: 'deferred', item_count: 0 };
  const status = input.output.decision_type === 'topic_group' ? 'draft' : 'research_needed';
  const statements = [
    input.db.prepare(
      `insert into topic_decision_results (
        id, workspace_id, site_id, run_id, submission_operation_id, strategy_version_id, strategy_version,
        decision_type, status, group_goal, rationale, group_hypothesis,
        expected_signals_json, risks_json, unknowns_json, previous_group_relationship,
        research_request_json, web_evidence_json, requested_count, locales_json, language_decisions_json,
        created_at, updated_at, scope_locale
      ) select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        where exists (
          select 1 from agent_runs
          where id = ? and workspace_id = ? and site_id = ? and agent_id = 'topic_decision'
            and status in ('queued', 'running', 'waiting_for_approval', 'waiting_for_input')
        )
        -- A Run delivers at most one decision batch.
        and not exists (select 1 from topic_decision_results other where other.run_id = ?)`,
    ).bind(
      resultId, input.workspaceId, input.siteId, input.runId, input.operationId || `legacy:${input.runId}`, input.strategyVersionId, input.strategyVersion,
      input.output.decision_type, status, group?.goal || '', input.output.rationale, group?.hypothesis || '',
      runtimeJson(group?.expected_signals || []), runtimeJson(group?.risks || []), runtimeJson(group?.unknowns || []),
      group?.previous_group_relationship || '', runtimeJson(input.output.research_request || {}), runtimeJson(input.webEvidence),
      input.requestedCount, runtimeJson(input.locales), runtimeJson(input.languageDecisions || []), at, at, input.scope.locale,
      input.runId, input.workspaceId, input.siteId, input.runId,
    ),
  ];
  const subjects: TaskSubject[] = [{ type: 'topic_group', id: resultId, version: input.operationId || null }];
  const deliveredItems: Array<{ id: string; content: unknown }> = [];
  for (const [index, item] of (group?.items || []).entries()) {
    const itemId = newId();
    subjects.push({ type: 'topic_item', id: itemId, version: input.operationId || null });
    deliveredItems.push({ id: itemId, content: item });
    const itemStrategy = input.strategyByLocale?.[item.locale] || {
      id: input.strategyVersionId,
      version: input.strategyVersion,
    };
    statements.push(input.db.prepare(
      `insert into topic_decision_items (
        id, result_id, strategy_keyword_id, keyword_id, topic_key, title_direction,
        primary_keyword, content_type, locale, search_intent, group_role,
        rationale, hypothesis, evidence_json, relationship_to_existing, risk, sort_order, created_at,
        strategy_version_id, strategy_version${item.library_keyword_id ? ', library_keyword_id' : ''}
      ) select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${item.library_keyword_id ? ', ?' : ''}
        where exists (select 1 from topic_decision_results where id = ? and run_id = ?)`,
    ).bind(
      itemId, resultId, item.strategy_keyword_id, item.keyword_id, item.topic_key, item.title_direction,
      item.primary_keyword, item.content_type, item.locale, item.search_intent, item.group_role,
      item.rationale, item.hypothesis, runtimeJson(item.evidence), item.relationship_to_existing, item.risk, index, at,
      itemStrategy.id, itemStrategy.version, ...(item.library_keyword_id ? [item.library_keyword_id] : []),
      resultId, input.runId,
    ));
  }
  if (input.captureDelivery && input.operationId && group) statements.push(...topicDeliveryStatements(input.db, {
    workspaceId: input.workspaceId, siteId: input.siteId, runId: input.runId, operationId: input.operationId, groupId: resultId, subjects,
    snapshot: { group_id: resultId, decision: input.output, items: deliveredItems },
  }));
  await input.db.batch(statements);
  if (!await input.db.prepare('select id from topic_decision_results where id=?').bind(resultId).first()) {
    if (await input.db.prepare('select id from topic_decision_results where run_id=?').bind(input.runId).first()) throw new Error('This Run already submitted its topic decision');
    throw new Error('Topic submission lost its execution gate');
  }
  return { id: resultId, decision: input.output.decision_type, status, item_count: group?.items.length || 0 };
}

/** A strategy task of this language that has not completed, been cancelled or failed. */
export async function unfinishedStrategyTask(db: D1Database, workspaceId: string, siteId: string, locale: string): Promise<{ id: string; status: string } | null> {
  return db.prepare(`select r.id,coalesce(t.status,r.status) as status from agent_runs r left join agent_tasks t on t.id=r.id
    where r.workspace_id=? and r.site_id=? and r.agent_id='strategy_research' and r.agent_instance_id=?
      and ((t.id is null and r.status in ('queued','running','waiting_for_approval','waiting_for_input'))
        or (t.id is not null and t.status not in ('completed','cancelled','failed')))
    order by r.created_at desc limit 1`).bind(workspaceId, siteId, `strategy:${locale}`).first<{ id: string; status: string }>();
}

/** A research request of this language that the dispatcher has neither started nor given up on. */
export async function undispatchedTopicResearchRequest(db: D1Database, workspaceId: string, siteId: string, locale: string): Promise<{ id: string } | null> {
  return db.prepare(`select id from topic_decision_results where workspace_id=? and site_id=? and scope_locale=?
    and status='research_needed' and research_run_id='' and research_dispatch_error=''
    and not exists(select 1 from agent_tasks t where t.active_run_id=topic_decision_results.run_id and t.parent_task_id!='')
    order by created_at limit 1`)
    .bind(workspaceId, siteId, locale).first<{ id: string }>();
}

export type TopicResearchDispatchRow = Pick<TopicDecisionResultRow, 'id' | 'workspace_id' | 'site_id' | 'run_id' | 'rationale' | 'research_request_json'> & { scope_locale: string };
export async function undispatchedTopicResearchRequests(db: D1Database, limit = 20): Promise<TopicResearchDispatchRow[]> {
  return (await db.prepare(`select id,workspace_id,site_id,run_id,rationale,research_request_json,scope_locale from topic_decision_results
    where status='research_needed' and research_run_id='' and research_dispatch_error=''
      and not exists(select 1 from agent_tasks t where t.active_run_id=topic_decision_results.run_id and t.parent_task_id!='')
      order by created_at limit ?`).bind(limit).all<TopicResearchDispatchRow>()).results;
}

/** Records the dispatch outcome once; a request is never linked to two strategy tasks. */
export async function recordTopicResearchDispatch(db: D1Database, resultId: string, outcome: { runId: string } | { error: string }): Promise<void> {
  await db.prepare(`update topic_decision_results set research_run_id=?,research_dispatch_error=?,updated_at=?
    where id=? and research_run_id='' and research_dispatch_error=''`)
    .bind('runId' in outcome ? outcome.runId : '', 'error' in outcome ? outcome.error.slice(0, 1000) : '', isoNow(), resultId).run();
}

export async function getTopicDecisionResult(
  db: D1Database,
  workspaceId: string,
  siteId: string,
  resultId: string,
): Promise<TopicDecisionResultRow | null> {
  return db.prepare(
    'select * from topic_decision_results where id = ? and workspace_id = ? and site_id = ?',
  ).bind(resultId, workspaceId, siteId).first<TopicDecisionResultRow>();
}

export async function rejectTopicDecisionResult(input: {
  db: D1Database; workspaceId: string; siteId: string; resultId: string; actorId: string; note: string; expectedUpdatedAt?: string; operationId?: string;
}): Promise<TopicDecisionResultRow> {
  if (!input.note.trim()) throw new Error('A reason must be provided when rejecting a topic group');
  const at = isoNow();
  const guard = input.expectedUpdatedAt ? ' and updated_at = ?' : '';
  const guardValues = input.expectedUpdatedAt ? [input.expectedUpdatedAt] : [];
  const [changed] = await input.db.batch([input.db.prepare(
    `update topic_decision_results set status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = ?, updated_at = ?${input.operationId ? ', review_operation_id = ?' : ''}
     where id = ? and workspace_id = ? and site_id = ? and status = 'draft'${guard}`,
  ).bind(input.actorId, input.note.slice(0, 2000), at, at, ...(input.operationId ? [input.operationId] : []), input.resultId, input.workspaceId, input.siteId, ...guardValues),
    input.db.prepare("update topics set status='rejected' where site_id=? and decision_group_id=? and status='draft' and exists(select 1 from topic_decision_results where id=? and workspace_id=? and status='rejected' and reviewed_at=?)").bind(input.siteId, input.resultId, input.resultId, input.workspaceId, at),
  ]);
  if (!changed.meta.changes) throw new Error('The topic group does not exist or has already been processed');
  return (await getTopicDecisionResult(input.db, input.workspaceId, input.siteId, input.resultId))!;
}

export async function approveTopicDecisionResult(input: {
  db: D1Database; workspaceId: string; siteId: string; resultId: string; actorId: string; note: string; expectedUpdatedAt?: string; operationId?: string;
  productionGroupId?: string; parentRunId?: string;
}): Promise<{ result: TopicDecisionResultRow; jobIds: string[]; productionGroupId: string; parentRunId: string }> {
  const result = await getTopicDecisionResult(input.db, input.workspaceId, input.siteId, input.resultId);
  if (!result || result.status !== 'draft' || result.decision_type !== 'topic_group') {
    throw new Error('The topic group does not exist or has already been processed');
  }
  const { results } = await input.db.prepare(
    'select * from topic_decision_items where result_id = ? order by sort_order asc',
  ).bind(result.id).all<TopicDecisionItemRow>();
  const items = results ?? [];
  if (!items.length) throw new Error('The topic group has no deliverable topics');
  if (!result.scope_locale || items.some(item => item.locale !== result.scope_locale)) throw new Error('Topic group scope does not match its items');
  const site = await input.db.prepare('select source_locale, translate_locales_json from sites where workspace_id = ? and id = ?')
    .bind(input.workspaceId, input.siteId).first<{ source_locale: string; translate_locales_json: string }>();
  if (!site) throw new Error('site not found');
  // Approval creates source content for the group's language only; no translations are added.
  const at = isoNow();
  const guard = input.expectedUpdatedAt ? ' and updated_at = ?' : '';
  const guardValues = input.expectedUpdatedAt ? [input.expectedUpdatedAt] : [];
  const productionGroupId = input.productionGroupId || newId();
  const parentRunId = input.parentRunId || newId();
  const jobIds: string[] = [];
  const statements = [input.db.prepare(
    `insert into content_production_groups (
      id, workspace_id, site_id, decision_group_id, parent_run_id, status,
      total_items, ready_items, failed_items, review_round, review_json, error, created_at, updated_at
    ) select ?, ?, ?, ?, ?, 'queued', ?, 0, 0, 0, '{}', '', ?, ?
      where exists (
        select 1 from topic_decision_results
        where id = ? and workspace_id = ? and site_id = ? and status = 'draft'${guard}
      )`,
  ).bind(
    productionGroupId, input.workspaceId, input.siteId, result.id, parentRunId, items.length, at, at,
    result.id, input.workspaceId, input.siteId, ...guardValues,
  )];
  for (const item of items) {
    const topicId = item.topic_id || newId();
    const jobId = newId();
    jobIds.push(jobId);
    const stableTopicKey = item.topic_id ? `library-${item.id}` : `agent-${result.id.slice(0, 8)}-${String(item.sort_order + 1).padStart(2, '0')}`;
    const plan = {
      locale: item.locale,
      decision_group_id: result.id,
      decision_item_id: item.id,
      strategy_version_id: item.strategy_version_id || result.strategy_version_id,
      strategy_keyword_id: item.strategy_keyword_id,
      ...(item.library_keyword_id ? { library_keyword_id: item.library_keyword_id } : {}),
      group_goal: result.group_goal,
      group_hypothesis: result.group_hypothesis,
      group_role: item.group_role,
      rationale: item.rationale,
      hypothesis: item.hypothesis,
      evidence: parseJson<unknown[]>(item.evidence_json, []),
      relationship_to_existing: item.relationship_to_existing,
      risk: item.risk,
    };
    statements.push(
      input.db.prepare(
        `insert into topics (
          id, site_id, topic_key, title_hint, category, primary_keyword, status, created_at,
          decision_group_id, decision_item_id, plan_json
        ) select ?, ?, ?, ?, ?, ?, 'used', ?, ?, ?, ?
          where exists (
            select 1 from topic_decision_results
            where id = ? and workspace_id = ? and site_id = ? and status = 'draft'${guard}
          ) on conflict(id) do update set status='used', plan_json=excluded.plan_json`,
      ).bind(
        topicId, input.siteId, stableTopicKey, item.title_direction, item.content_type, item.primary_keyword,
        at, result.id, item.id, runtimeJson(plan), result.id, input.workspaceId, input.siteId, ...guardValues,
      ),
      input.db.prepare(
        `insert into jobs (
          id, site_id, topic_id, status, translation_group, category, translate_locales_json, versions_json, source_locale,
          decision_group_id, decision_item_id, plan_json, production_group_id, created_at, updated_at
        ) select ?, ?, ?, 'queued', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?
          where exists (
            select 1 from topic_decision_results
            where id = ? and workspace_id = ? and site_id = ? and status = 'draft'${guard}
          )`,
      ).bind(
        jobId, input.siteId, topicId, stableTopicKey, item.content_type,
        '[]', item.locale,
        result.id, item.id, runtimeJson(plan), productionGroupId, at, at, result.id, input.workspaceId, input.siteId, ...guardValues,
      ),
      input.db.prepare(
        `update topic_decision_items set topic_id = ?, job_id = ?
         where id = ? and result_id = ?
           and exists (
             select 1 from topic_decision_results
             where id = ? and workspace_id = ? and site_id = ? and status = 'draft'${guard}
           )`,
      ).bind(topicId, jobId, item.id, result.id, result.id, input.workspaceId, input.siteId, ...guardValues),
    );
  }
  statements.push(input.db.prepare(
    `update topic_decision_results set status = 'handed_off', reviewed_by = ?, review_note = ?, reviewed_at = ?, updated_at = ?${input.operationId ? ', review_operation_id = ?' : ''}
     where id = ? and workspace_id = ? and site_id = ? and status = 'draft'${guard}`,
  ).bind(input.actorId, input.note.slice(0, 2000), at, at, ...(input.operationId ? [input.operationId] : []), result.id, input.workspaceId, input.siteId, ...guardValues));
  const batchResults = await input.db.batch(statements);
  const completion = batchResults.at(-1) as { meta?: { changes?: number } } | undefined;
  if (!Number(completion?.meta?.changes || 0)) throw new Error('A concurrency conflict occurred while delivering the topic group');
  const updated = await getTopicDecisionResult(input.db, input.workspaceId, input.siteId, result.id);
  if (updated?.status !== 'handed_off') throw new Error('A concurrency conflict occurred while delivering the topic group');
  return { result: updated, jobIds, productionGroupId, parentRunId };
}

function publicItem(item: TopicDecisionItemRow) {
  const { evidence_json: evidenceJson, ...rest } = item;
  return { ...rest, evidence: parseJson<unknown[]>(evidenceJson, []) };
}

function publicResult(result: TopicDecisionResultRow, items: TopicDecisionItemRow[]) {
  return {
    scope: { locale: result.scope_locale || '' },
    id: result.id, run_id: result.run_id, strategy_version_id: result.strategy_version_id,
    strategy_version: result.strategy_version, decision_type: result.decision_type, status: result.status,
    group_goal: result.group_goal, rationale: result.rationale, group_hypothesis: result.group_hypothesis,
    expected_signals: parseJson<string[]>(result.expected_signals_json, []),
    risks: parseJson<string[]>(result.risks_json, []), unknowns: parseJson<string[]>(result.unknowns_json, []),
    previous_group_relationship: result.previous_group_relationship,
    research_request: parseJson<Record<string, unknown>>(result.research_request_json, {}),
    language_decisions: parseJson<unknown[]>(result.language_decisions_json, []),
    web_evidence: parseJson<unknown[]>(result.web_evidence_json, []),
    requested_count: result.requested_count, locales: parseJson<string[]>(result.locales_json, []),
    reviewed_by: result.reviewed_by, review_note: result.review_note, reviewed_at: result.reviewed_at,
    created_at: result.created_at, updated_at: result.updated_at,
    items: items.map(publicItem),
  };
}

export async function publicTopicDecisionResult(
  db: D1Database,
  workspaceId: string,
  siteId: string,
  resultId: string,
) {
  const result = await getTopicDecisionResult(db, workspaceId, siteId, resultId);
  if (!result) return null;
  const rows = await db.prepare(
    'select * from topic_decision_items where result_id = ? order by sort_order asc',
  ).bind(resultId).all<TopicDecisionItemRow>();
  return publicResult(result, rows.results ?? []);
}

export async function topicDecisionPayload(db: D1Database, workspaceId: string, siteId: string, scope: TopicScope) {
  const filter = ' and scope_locale=?';
  const scopeValues = [scope.locale];
  const runFilter = " and json_extract(summary_json,'$.scope.locale')=?";
  const [runPage, resultRows] = await Promise.all([
    db.prepare(`select * from agent_runs where workspace_id=? and site_id=? and agent_id='topic_decision'${runFilter} order by created_at desc limit 20`).bind(workspaceId, siteId, ...scopeValues).all<AgentRun>(),
    db.prepare(
      `select * from topic_decision_results where workspace_id = ? and site_id = ?${filter} order by created_at desc limit 100`,
    ).bind(workspaceId, siteId, ...scopeValues).all<TopicDecisionResultRow>(),
  ]);
  const results = resultRows.results ?? [];
  const itemRows = results.length
    ? await db.prepare(`select * from topic_decision_items where result_id in (${results.map(() => '?').join(',')}) order by sort_order`).bind(...results.map(row => row.id)).all<TopicDecisionItemRow>()
    : { results: [] as TopicDecisionItemRow[] };
  const itemsByResult = new Map<string, TopicDecisionItemRow[]>();
  for (const item of itemRows.results ?? []) itemsByResult.set(item.result_id, [...(itemsByResult.get(item.result_id) || []), item]);
  const latestRun = runPage.results[0] || null;
  const trace = latestRun ? await Promise.all([
    listAgentEvents(db, latestRun.id, 0),
    db.prepare(
      `select id, tool_call_key, tool_name, tool_version, capability, status, input_json, output_json,
              error, retryable, duration_ms, started_at, finished_at
       from agent_tool_calls where run_id = ? order by started_at asc`,
    ).bind(latestRun.id).all<Record<string, unknown>>(),
    listRuntimeModelTrace(db, latestRun.id),
  ]) : null;
  const task = latestRun ? await taskForRun(db, latestRun.id) : null;
  return {
    task: task ? {id:task.id,status:task.status,outcome:task.outcome,reason:task.reason,...await taskExecutionView(db,task)} : null,
    agent_name: 'Topic decision agent', agent_id: 'topic_decision',
    latest_run: latestRun,
    latest_outcome: latestRun ? parseJson<Record<string, unknown>>(latestRun.output_json, {}) : {},
    events: trace?.[0] || [], tool_calls: trace?.[1].results || [], model_calls: trace?.[2] || [],
    results: results.map((result) => publicResult(result, itemsByResult.get(result.id) || [])),
  };
}

export function topicDecisionSummary(run: AgentRun): { groupSize: number; locales: string[] } {
  const summary = parseJson<Record<string, unknown>>(run.summary_json, {});
  const groupSize = Math.max(1, Math.min(20, Number(summary.group_size || 10)));
  const locales = Array.isArray(summary.locales)
    ? [...new Set(summary.locales.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))]
    : [];
  return { groupSize, locales };
}
