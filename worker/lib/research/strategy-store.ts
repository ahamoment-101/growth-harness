import { ToolContractError } from '../../agent-runtime/tool-failure';
import { taskDecisionTurns } from '../../agent-runtime/conversation-store';
import { taskExecutionView } from '../../agent-runtime/task-recovery';
import { type AgentTask, taskForRun, readTaskOperation } from '../../agent-runtime/task-store';
import { isoNow, newId } from '../../db';
import type { UrlCitation } from '../llm';
import { renderKeywordMapMarkdown, type StrategyResearchResult } from './ingest';
import { getAgentRun, listAgentEvents } from '../../agent-runtime/store';
import { runtimeJson } from '../../agent-runtime/protocol';
import { listRuntimeModelTrace } from '../../agent-runtime/observability';

export type StrategyRun = {
  id: string;
  site_id: string;
  trigger: string;
  status: 'running' | 'waiting' | 'ok' | 'failed' | 'cancelled';
  phase: string;
  workflow_id: string;
  model: string;
  source_locale: string;
  error: string;
  summary_json: string;
  started_at: string;
  finished_at: string;
};

export type StrategyVersion = {
  submission_operation_id?: string;
  id: string;
  site_id: string;
  run_id: string;
  version: number;
  status: 'draft' | 'active' | 'superseded';
  change_summary: string;
  business_snapshot_json: string;
  research_scope_json: string;
  source_locale: string;
  created_at: string;
};

type StrategyVersionRow = Omit<StrategyVersion, 'version'> & {
  version: number;
  locale_version?: number;
};

type StrategyDocument = {
  id: string;
  strategy_version_id: string;
  doc_type: 'strategy' | 'keyword_map' | 'research_notes';
  body_md: string;
  content_hash: string;
  created_at: string;
};

export type StrategyEvidenceSource = {
  source_type: 'gsc' | 'autocomplete' | 'competitor_snapshot' | 'deep_research';
  title: string;
  query?: string;
  observation_md: string;
  metadata?: Record<string, unknown>;
  observed_at?: string;
};

export async function insertStrategyRun(
  db: D1Database,
  siteId: string,
  trigger: 'manual' | 'cron' | 'retry' | 'sub_agent',
  model: string,
  sourceLocale: string,
  runId = newId(),
): Promise<StrategyRun> {
  const row: StrategyRun = {
    id: runId,
    site_id: siteId,
    trigger,
    status: 'running',
    phase: 'reading_business',
    workflow_id: '',
    model,
    source_locale: sourceLocale,
    error: '',
    summary_json: '{}',
    started_at: isoNow(),
    finished_at: '',
  };
  await db.prepare(
    `insert into seo_strategy_runs
     (id, site_id, trigger, instruction, status, phase, workflow_id, model, error, summary_json, started_at, finished_at, source_locale)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id, row.site_id, row.trigger, '', row.status, row.phase,
    row.workflow_id, row.model, row.error, row.summary_json, row.started_at, row.finished_at, row.source_locale,
  ).run();
  return row;
}

export async function updateStrategyRun(
  db: D1Database,
  id: string,
  patch: Partial<Pick<StrategyRun, 'status' | 'phase' | 'workflow_id' | 'error' | 'summary_json' | 'finished_at'>>,
): Promise<void> {
  const current = await db.prepare('select * from seo_strategy_runs where id = ?').bind(id).first<StrategyRun>();
  if (!current) return;
  const next = { ...current, ...patch };
  await db.prepare(
    'update seo_strategy_runs set status=?, phase=?, workflow_id=?, error=?, summary_json=?, finished_at=? where id=?',
  ).bind(next.status, next.phase, next.workflow_id, next.error, next.summary_json, next.finished_at, id).run();
}

export async function latestStrategyRun(db: D1Database, siteId: string, sourceLocale?: string): Promise<StrategyRun | null> {
  return (await db.prepare(
    `select * from seo_strategy_runs where site_id = ?
     ${sourceLocale ? 'and source_locale = ?' : ''} order by started_at desc limit 1`,
  ).bind(...(sourceLocale ? [siteId, sourceLocale] : [siteId])).first<StrategyRun>()) ?? null;
}

export async function getStrategyRun(db: D1Database, id: string): Promise<StrategyRun | null> {
  return (await db.prepare('select * from seo_strategy_runs where id = ?').bind(id).first<StrategyRun>()) ?? null;
}

export async function runningStrategyRun(db: D1Database, siteId: string, sourceLocale?: string): Promise<StrategyRun | null> {
  return (await db.prepare(
    `select * from seo_strategy_runs where site_id = ? and status = 'running'
     ${sourceLocale ? 'and source_locale = ?' : ''} order by started_at desc limit 1`,
  ).bind(...(sourceLocale ? [siteId, sourceLocale] : [siteId])).first<StrategyRun>()) ?? null;
}

export async function activeStrategyContext(db: D1Database, siteId: string, sourceLocale?: string): Promise<string> {
  const version = await activeStrategyVersion(db, siteId, sourceLocale);
  if (!version) return '';
  return strategyVersionContext(db, version.id);
}

export async function strategyVersionContext(db: D1Database, versionId: string): Promise<string> {
  const row = await db.prepare('select * from seo_strategy_versions where id = ?')
    .bind(versionId).first<StrategyVersionRow>();
  if (!row) return '';
  const version = businessStrategyVersion(row);
  const strategy = await db.prepare(
    "select body_md from seo_strategy_documents where strategy_version_id = ? and doc_type = 'strategy'",
  ).bind(version.id).first<{ body_md: string }>();
  const { results } = await db.prepare(
    `select k.term, k.locale, sk.priority_band, sk.decision, c.name as cluster_name
     from seo_strategy_keywords sk
     join seo_keywords k on k.id = sk.keyword_id
     join seo_keyword_clusters c on c.id = sk.cluster_id
     where sk.strategy_version_id = ?
     order by case sk.priority_band when 'high' then 0 when 'medium' then 1 else 2 end, c.sort_order asc
     limit 120`,
  ).bind(version.id).all<{ term: string; locale: string; priority_band: string; decision: string; cluster_name: string }>();
  const keywordLines = (results ?? []).map((row) =>
    `- ${row.term} [${row.locale}] ${row.cluster_name} ${row.priority_band} ${row.decision}`,
  );
  return [
    `Active strategy version: v${version.version} (${version.created_at})`,
    strategy?.body_md?.slice(0, 14000) || '',
    '',
    'Current strategic keyword map:',
    keywordLines.join('\n') || '(empty)',
  ].join('\n').slice(0, 22000);
}

export async function persistStrategyBundle(opts: {
  operationId?: string;
  db: D1Database;
  siteId: string;
  runId: string;
  sourceLocale: string;
  businessSnapshot: Record<string, number>;
  result: StrategyResearchResult;
  citations: UrlCitation[];
  evidenceSources?: StrategyEvidenceSource[];
  activate?: boolean;
}): Promise<StrategyVersion> {
  if (!opts.result.seo_strategy_md || !opts.result.research_notes_md) {
    throw new Error('strategy output missing required Markdown documents');
  }
  const replay = await opts.db.prepare(
    "select * from seo_strategy_versions where site_id = ? and submission_operation_id = ? and status != 'draft' limit 1",
  ).bind(opts.siteId, opts.operationId || `legacy:${opts.runId}`).first<StrategyVersionRow>();
  if (replay) return businessStrategyVersion(replay);
  await opts.db.prepare("delete from seo_strategy_versions where site_id = ? and submission_operation_id = ? and status = 'draft'")
    .bind(opts.siteId, opts.operationId || `legacy:${opts.runId}`).run();
  const version: StrategyVersion = {
    id: newId(),
    site_id: opts.siteId,
    run_id: opts.runId,
    submission_operation_id: opts.operationId || `legacy:${opts.runId}`,
    version: 0,
    status: 'draft',
    change_summary: opts.result.change_summary,
    business_snapshot_json: JSON.stringify(opts.businessSnapshot),
    research_scope_json: JSON.stringify({ summary: opts.result.research_scope_summary }),
    source_locale: opts.sourceLocale,
    created_at: isoNow(),
  };
  await insertStrategyVersionRow(opts.db, version);

  const sourceByUrl = await insertSources(opts.db, version.id, opts.citations, opts.evidenceSources ?? []);
  const territoryIds = new Map<string, string>();
  for (const [index, territory] of opts.result.territories.entries()) {
    const id = newId();
    territoryIds.set(territory.key, id);
    await opts.db.prepare(
      `insert into seo_topic_territories
       (id, strategy_version_id, territory_key, name, priority_band, status, audience_summary,
        search_job_summary, business_goal, conversion_goal, summary, sort_order)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, version.id, territory.key, territory.name, territory.priority_band, territory.status,
      territory.audience_summary, territory.search_job_summary, territory.business_goal,
      territory.conversion_goal, territory.summary, index,
    ).run();
  }

  const clusterIds = new Map<string, string>();
  for (const [index, cluster] of opts.result.clusters.entries()) {
    const territoryId = territoryIds.get(cluster.territory_key);
    if (!territoryId) continue;
    const id = newId();
    clusterIds.set(cluster.key, id);
    await opts.db.prepare(
      `insert into seo_keyword_clusters
       (id, strategy_version_id, territory_id, cluster_key, name, priority_band, status,
        strategic_role, recommended_hub, conversion_goal, summary, sort_order)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, version.id, territoryId, cluster.key, cluster.name, cluster.priority_band, cluster.status,
      cluster.strategic_role, cluster.recommended_hub, cluster.conversion_goal, cluster.summary, index,
    ).run();
  }

  for (const keyword of opts.result.keywords) {
    const clusterId = clusterIds.get(keyword.cluster_key);
    if (!clusterId) continue;
    const keywordId = await upsertKeyword(opts.db, opts.siteId, keyword.term, keyword.locale);
    const strategyKeywordId = newId();
    await opts.db.prepare(
      `insert into seo_strategy_keywords
       (id, strategy_version_id, keyword_id, cluster_id, intent, journey_stage, serp_shape,
        recommended_page_type, business_relevance, conversion_route, priority_band,
        priority_rationale, coverage_status, decision, existing_url, evidence_summary, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      strategyKeywordId, version.id, keywordId, clusterId, keyword.intent, keyword.journey_stage,
      keyword.serp_shape, keyword.recommended_page_type, keyword.business_relevance,
      keyword.conversion_route, keyword.priority_band, keyword.priority_rationale,
      keyword.coverage_status, keyword.decision, keyword.existing_url, keyword.evidence_summary,
      version.created_at,
    ).run();
    for (const url of keyword.source_urls) {
      const sourceId = sourceByUrl.get(url);
      if (!sourceId) continue;
      await opts.db.prepare(
        `insert or ignore into seo_keyword_sources
         (strategy_keyword_id, source_id, evidence_type, note) values (?, ?, 'web', ?)`,
      ).bind(strategyKeywordId, sourceId, keyword.evidence_summary).run();
    }
  }

  const sourceIndex = [...sourceByUrl.entries()].map(([url], index) => `${index + 1}. [${hostLabel(url)}](${url})`).join('\n');
  const researchNotes = [
    opts.result.research_notes_md.trim(),
    sourceIndex ? `## Web sources captured this time

${sourceIndex}` : '',
  ].filter(Boolean).join('\n\n');
  const documents: Array<[StrategyDocument['doc_type'], string]> = [
    ['strategy', opts.result.seo_strategy_md.trim()],
    // null means this version has no keyword map report (definition v34+); undefined keeps the historical rendering.
    ...(opts.result.keyword_map_md === null ? [] : [['keyword_map', opts.result.keyword_map_md ?? renderKeywordMapMarkdown(opts.result, version.version, version.created_at)] as [StrategyDocument['doc_type'], string]]),
    ['research_notes', researchNotes],
  ];
  for (const [docType, body] of documents) {
    await opts.db.batch([opts.db.prepare(
      `insert into seo_strategy_documents
       (id, strategy_version_id, doc_type, body_md, content_hash, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    ).bind(newId(), version.id, docType, body, contentHash(body), version.created_at),
    opts.db.prepare(`insert into seo_strategy_report_snapshots
      (strategy_version_id,doc_type,body_md,content_hash,created_at) values(?,?,?,?,?)`)
      .bind(version.id, docType, body, contentHash(body), version.created_at)]);
  }

  if (opts.activate !== false) {
    await opts.db.batch([
      opts.db.prepare("update seo_strategy_versions set status = 'superseded' where site_id = ? and source_locale = ? and status = 'active'").bind(opts.siteId, opts.sourceLocale),
      opts.db.prepare("update seo_strategy_versions set status = 'active' where id = ?").bind(version.id),
    ]);
    return { ...version, status: 'active' };
  }
  return version;
}

export async function finalizeRuntimeStrategyBundle(opts: {
  db: D1Database;
  siteId: string;
  runId: string;
  versionId: string;
  sourceLocale?: string;
  summary: unknown;
  /** Undefined is reserved for legacy callers; empty string explicitly expects no active version. */
  expectedBaseVersionId?: string;
  task?: { id: string; epoch: number; revision: number; operationId: string };
}): Promise<StrategyVersion> {
  const at = isoNow();
  const target = await opts.db.prepare('select source_locale from seo_strategy_versions where id = ?')
    .bind(opts.versionId).first<{ source_locale: string }>();
  const sourceLocale = opts.sourceLocale || target?.source_locale || '';
  const activeStatuses = "('queued', 'running', 'waiting_for_approval', 'waiting_for_input')";
  // Gate publication and task completion together; cancellation wins if it commits first.
  const taskGate = opts.task ? ` and exists(select 1 from agent_tasks t join agent_task_operations o on o.task_id = t.id
    where t.id = ? and t.active_run_id = ? and t.epoch = ? and t.revision = ? and t.status = 'running'
    and o.id = ? and o.turn = t.next_turn and o.status in ('ready','running'))` : '';
  const taskBindings = opts.task ? [opts.task.id, opts.runId, opts.task.epoch, opts.task.revision, opts.task.operationId] : [];
  const baseline = opts.expectedBaseVersionId;
  const matchBase = baseline === undefined ? '' : ' and id = ?';
  // These two mutations are adjacent in one atomic D1 batch. A non-empty expected base
  // must actually be superseded by the immediately preceding mutation before activation.
  const activateBase = baseline === undefined ? '' : ` and (? = '' or changes() = 1)
    and not exists(select 1 from seo_strategy_versions where site_id = ? and source_locale = ? and status = 'active')`;
  await opts.db.batch([
    opts.db.prepare(
      `update seo_strategy_versions set status = 'superseded'
       where site_id = ? and source_locale = ? and status = 'active'
         and exists (select 1 from agent_runs where id = ? and status in ${activeStatuses})${taskGate}
         and exists (select 1 from seo_strategy_versions where id = ? and site_id = ? and run_id = ? and source_locale = ? and status = 'draft')${matchBase}`,
    ).bind(opts.siteId, sourceLocale, opts.runId, ...taskBindings, opts.versionId, opts.siteId, opts.runId, sourceLocale, ...(baseline === undefined ? [] : [baseline])),
    opts.db.prepare(
      `update seo_strategy_versions set status = 'active'
       where id = ? and site_id = ? and run_id = ? and source_locale = ? and status = 'draft'
         and exists (select 1 from agent_runs where id = ? and status in ${activeStatuses})${taskGate}${activateBase}`,
    ).bind(opts.versionId, opts.siteId, opts.runId, sourceLocale, opts.runId, ...taskBindings, ...(baseline === undefined ? [] : [baseline, opts.siteId, sourceLocale])),
    opts.db.prepare(`update agent_runs set output_json=?,updated_at=? where id=?
      and exists(select 1 from seo_strategy_versions where id=? and status='active')`)
      .bind(runtimeJson(opts.summary), at, opts.runId, opts.versionId),
    opts.db.prepare(`update seo_strategy_runs set summary_json=?,phase='strategy_submitted' where id=?
      and exists(select 1 from seo_strategy_versions where id=? and status='active')`)
      .bind(runtimeJson(opts.summary), opts.runId, opts.versionId),
    ...(opts.task ? [opts.db.prepare(`update agent_task_operations set status='succeeded',output_json=? where id=?
      and exists(select 1 from seo_strategy_versions where id=? and status='active')${taskGate}`)
      .bind(runtimeJson(opts.summary), opts.task.operationId, opts.versionId, ...taskBindings)] : []),
  ]);
  const [run, version] = await Promise.all([
    getAgentRun(opts.db, opts.runId),
    opts.db.prepare('select * from seo_strategy_versions where id = ?').bind(opts.versionId).first<StrategyVersionRow>(),
  ]);
  if (!run || version?.status !== 'active') {
    if (baseline !== undefined && version?.status === 'draft') {
      const active = await activeStrategyVersion(opts.db, opts.siteId, sourceLocale);
      if ((active?.id || '') !== baseline) throw new ToolContractError('Active strategy changed while this research was running', {
        kind: 'state_conflict', effects: 'preserved',
        issues: [{ path: ['expected_base_version_id'], message: `Expected ${baseline || '(none)'}; current active version is ${active?.id || '(none)'}.` }],
        guidance: 'Your working draft is preserved. Read the current strategy, decide whether to revise or keep it, and explicitly supply its version ID if submitting after reconciliation.',
      });
    }
    throw new Error(`Strategy completion lost its active Run gate (run=${run?.status || 'missing'})`);
  }
  return businessStrategyVersion(version);
}

export async function strategyPayload(
  db: D1Database,
  siteId: string,
  sourceLocale: string,
  requestedVersion?: number,
  options: { includeRuntime?: boolean; controlsEnabled?: boolean; retryEnabled?: boolean; chatEnabled?: boolean } = {},
) {
  const [run, versions] = await Promise.all([
    latestStrategyRun(db, siteId, sourceLocale),
    listStrategyVersions(db, siteId, sourceLocale),
  ]);
  const selected = requestedVersion != null
    ? versions.find((version) => version.version === requestedVersion) ?? null
    : versions.find((version) => version.status === 'active') ?? null;
  const runtimeRun = options.includeRuntime !== false && run ? await getAgentRun(db, run.id) : null;
  const task = run ? await taskForRun(db, run.id) : null;
  const pendingOperation = task ? await readTaskOperation(db, task.id, task.next_turn) : null;
  const executionView = task ? await taskExecutionView(db, task) : null;
  const decisionTurns = task ? await taskDecisionTurns(db, task) : 0;
  const runtimeTrace = runtimeRun ? await loadRuntimeTrace(db, runtimeRun.id, task?.id) : null;
  const runtime = runtimeRun && runtimeTrace ? {
    run: runtimeRun,
    task: task ? { ...executionView!, current_action: pendingOperation ? String(JSON.parse(pendingOperation.action_json).name || '') : '', id: task.id, status: task.status, outcome: task.outcome, reason: task.reason, revision: task.revision, next_turn: task.next_turn, decision_turns: decisionTurns, model_calls: task.model_calls, reserved_tokens: task.reserved_tokens } : null,
    ...runtimeTrace,
    controls: {
      cancel: Boolean(options.controlsEnabled) && (task ? executionView!.allowed_actions.includes('cancel') : ['queued', 'running', 'waiting_for_approval', 'waiting_for_input'].includes(runtimeRun.status)),
      resume: Boolean(options.controlsEnabled && options.retryEnabled) && (task ? executionView!.allowed_actions.includes('resume') : ['failed', 'cancelled'].includes(runtimeRun.status)),
      approve: Boolean(options.controlsEnabled) && runtimeRun.status === 'waiting_for_approval',
      reject: Boolean(options.controlsEnabled) && runtimeRun.status === 'waiting_for_approval',
      provide_input: Boolean(options.controlsEnabled) && (task ? task.status === 'waiting' : runtimeRun.status === 'waiting_for_input'),
    },
    chat_enabled: false,
  } : null;
  if (!selected) {
    return {
      agent_name: 'Strategist',
      locale: sourceLocale,
      run: publicStrategyRun(run, task),
      strategy: null,
      documents: { strategy: null, keyword_map: null, research_notes: null },
      versions: [],
      stats: { territories: 0, clusters: 0, keywords: 0, sources: 0, library_keywords: await libraryKeywordCount(db, siteId, sourceLocale) },
      runtime,
    };
  }
  const [documents, territoryCount, clusterCount, keywordCount, sourceCount, libraryKeywords] = await Promise.all([
    listStrategyDocuments(db, selected.id),
    countOf(db, 'seo_topic_territories', selected.id),
    countOf(db, 'seo_keyword_clusters', selected.id),
    countOf(db, 'seo_strategy_keywords', selected.id),
    countOf(db, 'seo_research_sources', selected.id),
    libraryKeywordCount(db, siteId, sourceLocale),
  ]);
  return {
    agent_name: 'Strategist',
    locale: sourceLocale,
    run: publicStrategyRun(run, task),
    strategy: publicStrategyVersion(selected),
    documents,
    versions: versions.map(publicStrategyVersion),
    stats: { territories: territoryCount, clusters: clusterCount, keywords: keywordCount, sources: sourceCount, library_keywords: libraryKeywords },
    runtime,
  };
}

async function loadRuntimeTrace(db: D1Database, runId: string, taskId?: string) {
  const [events, toolCalls, modelCalls, approvals, childRuns] = await Promise.all([
    listAgentEvents(db, runId, 0),
    db.prepare(
      `select id, tool_call_key, tool_name, tool_version, capability, status, input_json, output_json,
              error, retryable, duration_ms, started_at, finished_at
       from agent_tool_calls where run_id = ? order by started_at asc`,
    ).bind(runId).all<Record<string, unknown>>(),
    listRuntimeModelTrace(db, runId),
    db.prepare(
      `select id, tool_call_key, status, requested_json, decided_by, decision_note, requested_at, decided_at
       from agent_approvals where run_id = ? order by requested_at asc`,
    ).bind(runId).all<Record<string, unknown>>(),
    db.prepare(
      `select id, agent_id, status, phase, parent_run_id, root_run_id, error, created_at, finished_at
       from agent_runs where parent_run_id = ? or parent_run_id in (select run_id from agent_task_runs where task_id = ?) order by created_at asc`,
    ).bind(runId, taskId || '').all<Record<string, unknown>>(),
  ]);
  const taskOperations = taskId ? await db.prepare(`select id,action_json,status,output_json,error,created_at,updated_at
    from agent_task_operations where task_id = ? and status != 'deciding' order by turn`).bind(taskId).all<{
      id: string; action_json: string; status: string; output_json: string; error: string; created_at: string; updated_at: string;
    }>() : null;
  return {
    events,
    tool_calls: taskOperations ? taskOperations.results.map((operation) => {
      const action = JSON.parse(operation.action_json);
      return { id: operation.id, tool_call_key: operation.id, tool_name: action.name, tool_version: 1, capability: 'task',
        status: operation.status === 'ready' ? 'running' : operation.status === 'unknown' ? 'failed' : operation.status,
        input_json: runtimeJson(action.input), output_json: runtimeJson(JSON.parse(operation.output_json)),
        error: operation.error, retryable: 0, duration_ms: 0, started_at: operation.created_at,
        finished_at: ['succeeded', 'failed'].includes(operation.status) ? operation.updated_at : '',
      };
    }) : toolCalls.results ?? [],
    model_calls: modelCalls,
    approvals: approvals.results ?? [],
    child_runs: childRuns.results ?? [],
  };
}

export async function listStrategyVersions(db: D1Database, siteId: string, sourceLocale?: string): Promise<StrategyVersion[]> {
  const { results } = await db.prepare(
    `select * from seo_strategy_versions where site_id = ? and status != 'draft'
     ${sourceLocale ? 'and source_locale = ?' : ''} order by locale_version desc limit 30`,
  ).bind(...(sourceLocale ? [siteId, sourceLocale] : [siteId])).all<StrategyVersionRow>();
  return (results ?? []).map(businessStrategyVersion);
}

export async function activeStrategyVersion(db: D1Database, siteId: string, sourceLocale?: string): Promise<StrategyVersion | null> {
  const row = await db.prepare(
    `select * from seo_strategy_versions where site_id = ? and status = 'active'
     ${sourceLocale ? 'and source_locale = ?' : ''} order by locale_version desc limit 1`,
  ).bind(...(sourceLocale ? [siteId, sourceLocale] : [siteId])).first<StrategyVersionRow>();
  return row ? businessStrategyVersion(row) : null;
}

async function insertStrategyVersionRow(db: D1Database, version: StrategyVersion): Promise<void> {
  await db.prepare(`insert into seo_strategy_versions
    (id,site_id,run_id,submission_operation_id,version,locale_version,status,change_summary,business_snapshot_json,research_scope_json,source_locale,created_at)
    select ?,?,?,?,coalesce((select max(version) from seo_strategy_versions where site_id=?),0)+1,
      coalesce((select max(locale_version) from seo_strategy_versions where site_id=? and source_locale=?),0)+1,?,?,?,?,?,?`)
    .bind(version.id, version.site_id, version.run_id, version.submission_operation_id || `legacy:${version.run_id}`,
      version.site_id, version.site_id, version.source_locale, version.status, version.change_summary,
      version.business_snapshot_json, version.research_scope_json, version.source_locale, version.created_at).run();
  const saved = await db.prepare('select locale_version from seo_strategy_versions where id=?').bind(version.id).first<{locale_version:number}>();
  if (!saved) throw new Error('Strategy submission allocation failed');
  version.version = saved.locale_version;
}

function businessStrategyVersion(row: StrategyVersionRow): StrategyVersion {
  return { ...row, version: Number(row.locale_version || row.version) };
}

export async function listStrategyLocaleSummaries(db: D1Database, siteId: string, locales: string[]) {
  return Promise.all([...new Set(locales.filter(Boolean))].map(async (locale) => {
    const [run, versions] = await Promise.all([
      latestStrategyRun(db, siteId, locale),
      listStrategyVersions(db, siteId, locale),
    ]);
    const active = versions.find((version) => version.status === 'active') ?? null;
    const task = run ? await taskForRun(db, run.id) : null;
    return {
      locale,
      run: publicStrategyRun(run, task),
      strategy: active ? publicStrategyVersion(active) : null,
      version_count: versions.length,
    };
  }));
}

async function listStrategyDocuments(db: D1Database, versionId: string) {
  const { results } = await db.prepare(
    'select * from seo_strategy_documents where strategy_version_id = ?',
  ).bind(versionId).all<StrategyDocument>();
  const byType = new Map((results ?? []).map((document) => [document.doc_type, document]));
  const view = (type: StrategyDocument['doc_type']) => {
    const document = byType.get(type);
    return document ? { body: document.body_md, created_at: document.created_at } : null;
  };
  return { strategy: view('strategy'), keyword_map: view('keyword_map'), research_notes: view('research_notes') };
}

async function insertSources(
  db: D1Database,
  strategyVersionId: string,
  citations: UrlCitation[],
  evidenceSources: StrategyEvidenceSource[],
): Promise<Map<string, string>> {
  const sourceByUrl = new Map<string, string>();
  for (const citation of citations) {
    if (!/^https?:\/\//i.test(citation.url) || sourceByUrl.has(citation.url)) continue;
    const id = newId();
    sourceByUrl.set(citation.url, id);
    await db.prepare(
      `insert into seo_research_sources
       (id, strategy_version_id, source_type, url, title, query, locale, status,
        observation_md, metadata_json, observed_at)
       values (?, ?, 'web', ?, ?, ?, '', 'ok', ?, '{}', ?)`,
    ).bind(id, strategyVersionId, citation.url, citation.title || hostLabel(citation.url), citation.query || '', citation.content.slice(0, 1200), isoNow()).run();
  }
  for (const source of evidenceSources) {
    if (!source.observation_md.trim()) continue;
    await db.prepare(
      `insert into seo_research_sources
       (id, strategy_version_id, source_type, url, title, query, locale, status,
        observation_md, metadata_json, observed_at)
       values (?, ?, ?, '', ?, ?, '', 'ok', ?, ?, ?)`,
    ).bind(
      newId(), strategyVersionId, source.source_type, source.title, source.query || '',
      source.observation_md.slice(0, 12000), JSON.stringify(source.metadata || {}), source.observed_at || isoNow(),
    ).run();
  }
  return sourceByUrl;
}

async function upsertKeyword(
  db: D1Database,
  siteId: string,
  term: string,
  locale: string,
): Promise<string> {
  const normalized = normalizeTerm(term);
  const existing = await db.prepare(
    `select id from seo_keywords
     where site_id = ? and normalized_term = ? and locale = ?`,
  ).bind(siteId, normalized, locale).first<{ id: string }>();
  if (existing) {
    await db.prepare('update seo_keywords set term = ?, last_seen_at = ? where id = ?')
      .bind(term, isoNow(), existing.id).run();
    return existing.id;
  }
  const id = newId();
  const now = isoNow();
  await db.prepare(
    `insert into seo_keywords
     (id, site_id, term, normalized_term, locale, lifecycle_status, first_seen_at, last_seen_at)
     values (?, ?, ?, ?, ?, 'candidate', ?, ?)`,
  ).bind(id, siteId, term, normalized, locale, now, now).run();
  return id;
}

/** Current active keywords in this language's library. Strategy versions from v34 keep no keyword list. */
async function libraryKeywordCount(db: D1Database, siteId: string, sourceLocale: string): Promise<number> {
  let locale = sourceLocale;
  try { locale = new Intl.Locale(sourceLocale).toString(); } catch { return 0; }
  const row = await db.prepare("select count(*) as n from keyword_library_entries where site_id = ? and locale = ? and kind = 'keyword' and archived = 0")
    .bind(siteId, locale).first<{ n: number }>();
  return Number(row?.n || 0);
}

async function countOf(db: D1Database, table: string, strategyVersionId: string): Promise<number> {
  const allowed = new Set(['seo_topic_territories', 'seo_keyword_clusters', 'seo_strategy_keywords', 'seo_research_sources']);
  if (!allowed.has(table)) return 0;
  const row = await db.prepare(`select count(*) as n from ${table} where strategy_version_id = ?`)
    .bind(strategyVersionId).first<{ n: number }>();
  return Number(row?.n || 0);
}

function publicStrategyRun(run: StrategyRun | null, task: AgentTask | null) {
  if (!run) return null;
  let summary: unknown = {};
  try { summary = JSON.parse(run.summary_json || '{}'); } catch { summary = {}; }
  return {
    id: run.id,
    trigger: run.trigger,
    status: task ? task.status === 'completed' ? 'ok' : task.status === 'cancelled' ? 'cancelled' : task.status === 'failed' ? 'failed' : task.status === 'running' ? 'running' : 'waiting' : run.status,
    phase: task?.status || run.phase,
    outcome: task?.outcome || '',
    error: task ? task.status === 'failed' ? task.reason : '' : run.error,
    summary,
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
}

function publicStrategyVersion(version: StrategyVersion) {
  let businessSnapshot: unknown = {};
  let researchScope: unknown = {};
  try { businessSnapshot = JSON.parse(version.business_snapshot_json || '{}'); } catch { businessSnapshot = {}; }
  try { researchScope = JSON.parse(version.research_scope_json || '{}'); } catch { researchScope = {}; }
  return {
    id: version.id,
    version: version.version,
    status: version.status,
    change_summary: version.change_summary,
    business_snapshot: businessSnapshot,
    research_scope: researchScope,
    source_locale: version.source_locale,
    created_at: version.created_at,
  };
}

function normalizeTerm(term: string): string {
  return term.trim().toLocaleLowerCase().normalize('NFKC').replace(/\s+/g, ' ');
}

function contentHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function hostLabel(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
