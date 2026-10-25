import type {
  D1Database,
  D1PreparedStatement,
} from '@cloudflare/workers-types';
import type {
  LearningData,
  LearningDetail,
  LearningRecord,
  LearningScope,
  LearningSection,
  LearningPage,
} from '../../shared/learning';
import { readRuntimeJson } from '../agent-runtime/runtime-content';
import { taskDataJson } from '../agent-runtime/task-store';
import { ToolContractError } from '../agent-runtime/tool-failure';
import { utilityFromFeedback } from './calculation';
import type { EvidenceAttribution } from './attribution';

export type RecordRow = {
  id: string;
  workspace_id: string;
  site_id: string;
  origin_task_id: string;
  version: number;
  title: string;
  status: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};
export type LearningRequest = {
  id: string;
  record_id: string;
  phase: 'prepare' | 'record' | 'feedback';
  payload_json: string;
  status: string;
  failure_count: number;
  run_id: string;
  error: string;
  available_at: string;
};
export const now = () => new Date().toISOString();
export const recordView = (r: RecordRow): LearningRecord => ({
  ...JSON.parse(r.data_json),
  id: r.id,
  version: r.version,
  title: r.title,
  status: r.status,
  created_at: r.created_at,
  updated_at: r.updated_at,
});
export const emptyLearning = (goal: string): LearningData => ({
  intent: { goal, context: '', expectation: '' },
  experience: {
    hypothesis: '',
    approach: '',
    adjustments: [],
    delivery: '',
    evaluation: null,
    observation: null,
    assessment: null,
    preparation: 'pending',
    gaps: [],
  },
  utility: utilityFromFeedback([]),
});

export async function getRecord(
  db: D1Database,
  scope: LearningScope,
  id: string,
) {
  return db
    .prepare(
      'select * from learning_records where id=? and workspace_id=? and site_id=?',
    )
    .bind(id, scope.workspaceId, scope.siteId)
    .first<RecordRow>();
}
export async function requireRecord(
  db: D1Database,
  scope: LearningScope,
  id: string,
) {
  const row = await getRecord(db, scope, id);
  if (!row)
    throw new ToolContractError(
      'Learning record is unavailable in this scope',
      {
        kind: 'invalid_request',
        effects: 'none',
        issues: [
          {
            path: ['experience_id'],
            message: `Unknown scoped experience: ${id}`,
          },
        ],
        guidance:
          "Search the site history for available records and copy its complete id unchanged. A task id or another Agent's observation_ref is not an experience id.",
      },
    );
  return row;
}
export async function listRecords(
  db: D1Database,
  scope: LearningScope,
  query = '',
  status = '',
  before = '',
  limit = 20,
) {
  const size = Math.min(50, Math.max(1, limit));
  const rows = await db
    .prepare(
      `select * from learning_records where workspace_id=? and site_id=?
    ${status ? 'and status=?' : ''} ${before ? 'and (updated_at<? or (updated_at=? and id<?))' : ''}
    ${query ? 'and (instr(lower(title),lower(?))>0 or instr(lower(data_json),lower(?))>0)' : ''}
    order by updated_at desc,id desc limit ?`,
    )
    .bind(
      scope.workspaceId,
      scope.siteId,
      ...(status ? [status] : []),
      ...(before
        ? [before.slice(0, 24), before.slice(0, 24), before.slice(24)]
        : []),
      ...(query ? [query, query] : []),
      size + 1,
    )
    .all<RecordRow>();
  const visible = rows.results.slice(0, size);
  return {
    records: visible.map(recordView),
    next_cursor:
      rows.results.length > size
        ? visible.at(-1)!.updated_at + visible.at(-1)!.id
        : null,
  };
}
export async function learningPage(
  db: D1Database,
  scope: LearningScope,
  id: string,
  section: LearningSection,
  after = '',
): Promise<LearningPage> {
  await requireRecord(db, scope, id);
  // Cursor fields are fixed by the implementation, never interpolated from caller input.
  const config = {
    evidence: { table: 'learning_evidence', where: 'record_id', key: 'id' },
    uses: {
      table: 'learning_uses',
      where: 'practice_id',
      key: "experience_id||':'||task_id",
    },
    adopted_by: {
      table: 'learning_uses',
      where: 'experience_id',
      key: "practice_id||':'||task_id",
    },
    tasks: { table: 'learning_tasks', where: 'record_id', key: 'task_id' },
    observations: {
      table: 'learning_observations',
      where: 'record_id',
      key: 'id',
    },
  }[section];
  if (!config) throw new Error('Unknown learning section');
  const rows = (
    await db
      .prepare(
        `select *,${section === 'adopted_by' ? `(select reward from learning_feedback f where f.practice_id=learning_uses.practice_id and f.experience_id=learning_uses.experience_id) as feedback_reward, exists(select 1 from learning_feedback f where f.practice_id=learning_uses.practice_id and f.experience_id=learning_uses.experience_id) as feedback_received,` : ''}${config.key} as page_key from ${config.table} where ${config.where}=? ${after ? `and (${config.key})>?` : ''} order by ${config.key} limit 51`,
      )
      .bind(id, ...(after ? [after] : []))
      .all<Record<string, unknown>>()
  ).results;
  const visible = rows.slice(0, 50);
  const items = await Promise.all(
    visible.map(async ({ page_key: _key, payload_json, attribution_json, ...r }) => {
      if (!payload_json) return r;
      const payload = JSON.parse(String(payload_json));
      if (r.kind === 'report' && payload.output)
        payload.output = await readRuntimeJson(
          db,
          JSON.stringify(payload.output),
        );
      return { ...r, payload, ...(attribution_json ? { attribution: JSON.parse(String(attribution_json)) } : {}) };
    }),
  );
  return {
    section,
    items: items as LearningPage['items'],
    next_cursor: rows.length > 50 ? String(visible.at(-1)!.page_key) : null,
  };
}
export async function recordDetail(
  db: D1Database,
  scope: LearningScope,
  id: string,
): Promise<LearningDetail> {
  const record = recordView(await requireRecord(db, scope, id));
  const sections = [
    'evidence',
    'uses',
    'adopted_by',
    'tasks',
    'observations',
  ] as const;
  const pages = await Promise.all(
    sections.map((section) => learningPage(db, scope, id, section)),
  );
  const processing = (
    await db
      .prepare(
        "select id,phase,status,error,failure_count from learning_requests where record_id=? and status not in ('completed','skipped') order by created_at,id limit 50",
      )
      .bind(id)
      .all<LearningDetail['processing'][number]>()
  ).results;
  return {
    record,
    ...Object.fromEntries(pages.map((page) => [page.section, page.items])),
    next_cursors: Object.fromEntries(
      pages.filter((p) => p.next_cursor).map((p) => [p.section, p.next_cursor]),
    ),
    processing,
  } as LearningDetail;
}
export async function taskLearning(
  db: D1Database,
  scope: LearningScope,
  taskId: string,
) {
  const formed = await db
    .prepare(
      `select r.* from learning_tasks t join learning_records r on r.id=t.record_id where t.task_id=? and r.workspace_id=? and r.site_id=?`,
    )
    .bind(taskId, scope.workspaceId, scope.siteId)
    .first<RecordRow>();
  const used = await db
    .prepare(
      `select r.*,u.reason from learning_uses u join learning_records r on r.id=u.experience_id where u.task_id=? and r.workspace_id=? and r.site_id=? order by u.created_at limit 100`,
    )
    .bind(taskId, scope.workspaceId, scope.siteId)
    .all<RecordRow & { reason: string }>();
  return {
    formed: formed ? recordView(formed) : null,
    used: used.results.map((r) => ({ ...recordView(r), reason: r.reason })),
  };
}

export async function replayOperation(
  db: D1Database,
  scope: LearningScope,
  operationId: string,
  input: unknown,
) {
  const found = await db
    .prepare('select * from learning_operations where id=?')
    .bind(operationId)
    .first<{
      workspace_id: string;
      site_id: string;
      input_json: string;
      result_json: string;
    }>();
  if (!found) return null;
  if (
    found.workspace_id !== scope.workspaceId ||
    found.site_id !== scope.siteId ||
    found.input_json !== taskDataJson(input)
  )
    throw new Error('Learning operation identity conflict');
  return JSON.parse(found.result_json) as {
    record_id: string;
    version: number;
  };
}
export async function commitRecords(
  db: D1Database,
  scope: LearningScope,
  operationId: string,
  input: unknown,
  changes: Array<{
    previous: RecordRow;
    data: LearningData;
    title?: string;
    status?: string;
  }>,
  extra: D1PreparedStatement[] = [],
) {
  const replay = await replayOperation(db, scope, operationId, input);
  if (replay) return replay;
  if (!changes.length) throw new Error('Learning commit needs a record');
  const at = now();
  const result = {
    record_id: changes[0].previous.id,
    version: changes[0].previous.version + 1,
  };
  const statements = [
    db
      .prepare(
        'insert into learning_operations(id,workspace_id,site_id,input_json,result_json,created_at) values(?,?,?,?,?,?)',
      )
      .bind(
        operationId,
        scope.workspaceId,
        scope.siteId,
        taskDataJson(input),
        JSON.stringify(result),
        at,
      ),
    ...changes.map((c) =>
      db
        .prepare(
          'insert into learning_revisions(operation_id,record_id,version,title,status,data_json,created_at) values(?,?,?,?,?,?,?)',
        )
        .bind(
          operationId,
          c.previous.id,
          c.previous.version + 1,
          c.title ?? c.previous.title,
          c.status ?? c.previous.status,
          JSON.stringify(c.data),
          at,
        ),
    ),
    ...extra,
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    const saved = await replayOperation(db, scope, operationId, input);
    if (saved) return saved;
    const current = await Promise.all(
      changes.map((change) => getRecord(db, scope, change.previous.id)),
    );
    const stale = changes.filter(
      (change, i) => current[i]?.version !== change.previous.version,
    );
    if (stale.length)
      throw new ToolContractError('Learning revision conflict', {
        kind: 'state_conflict',
        effects: 'none',
        issues: stale.map((change) => ({
          path: ['observation_ref'],
          message: `Observed version changed: ${change.previous.id} v${change.previous.version}`,
        })),
        guidance:
          'This transaction was not applied. Read the affected learning records again to obtain their current version references; existing evidence and other successful work remain saved.',
      });
    throw error;
  }
  return result;
}

export async function createPractice(
  db: D1Database,
  scope: LearningScope,
  taskId: string,
  agentId: string,
  goal: string,
  preparation?: { id: string; material: unknown },
) {
  const id = preparation?.id || `practice:${taskId}`;
  const at = now();
  await db.batch([
    db
      .prepare(
        'insert or ignore into learning_records(id,workspace_id,site_id,origin_task_id,title,data_json,created_at,updated_at) values(?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        scope.workspaceId,
        scope.siteId,
        taskId,
        goal.slice(0, 200) || 'New business practice',
        JSON.stringify(emptyLearning(goal)),
        at,
        at,
      ),
    ...(!preparation ? [db
      .prepare(
        'insert or ignore into learning_tasks(task_id,record_id,agent_id) values(?,?,?)',
      )
      .bind(taskId, id, agentId)] : []),
    db
      .prepare(
        'insert or ignore into learning_requests(id,record_id,phase,payload_json,available_at,created_at,updated_at,observation_bound) values(?,?,?,?,?,?,?,1)',
      )
      .bind(
        `prepare:${id}`,
        id,
        'prepare',
        JSON.stringify(preparation?.material || { goal }),
        at,
        at,
        at,
      ),
  ]);
  return requireRecord(db, scope, id);
}
export async function addEvidence(
  db: D1Database,
  scope: LearningScope,
  recordId: string,
  id: string,
  kind: string,
  sourceRef: string,
  payload: unknown,
  attribution?: EvidenceAttribution,
) {
  await requireRecord(db, scope, recordId);
  const at = now(),
    json = taskDataJson(payload);
  const prior = await db
    .prepare('select record_id,payload_json,attribution_json from learning_evidence where id=?')
    .bind(id)
    .first<{ record_id: string; payload_json: string; attribution_json: string }>();
  if (prior && (prior.record_id !== recordId || prior.payload_json !== json || (attribution && prior.attribution_json !== JSON.stringify(attribution))))
    throw new Error('Evidence identity conflict');
  await db.batch([
    db
      .prepare(
        'insert or ignore into learning_evidence(id,record_id,kind,source_ref,payload_json,created_at,attribution_json) values(?,?,?,?,?,?,?)',
      )
      .bind(id, recordId, kind, sourceRef, json, at, JSON.stringify(attribution || { subjects: [] })),
    db
      .prepare(
        'insert or ignore into learning_requests(id,record_id,phase,payload_json,available_at,created_at,updated_at,observation_bound) values(?,?,?,?,?,?,?,1)',
      )
      .bind(
        `evidence:${id}`,
        recordId,
        kind === 'outcome' ? 'feedback' : 'record',
        JSON.stringify({ evidence_ref: id }),
        at,
        at,
        at,
      ),
  ]);
}
export async function adoptExperience(
  db: D1Database,
  scope: LearningScope,
  taskId: string,
  agentId: string,
  experienceId: string,
  reason: string,
  compatibility: string,
  operationId: string,
  observedVersion: number,
  practiceId?: string,
) {
  const input = {
    taskId,
    agentId,
    experienceId,
    reason,
    compatibility,
    observedVersion,
    ...(practiceId ? { practiceId } : {}),
  };
  const replay = await replayOperation(db, scope, operationId, input);
  if (replay) return { ...replay, adopted: true };
  const link = practiceId
    ? { formed: recordView(await requireRecord(db, scope, practiceId)) }
    : await taskLearning(db, scope, taskId);
  if (!link.formed)
    throw new Error('This task is not linked to a business practice');
  if (link.formed.id === experienceId)
    throw new Error('A practice cannot provide its own usage feedback');
  const history = await requireRecord(db, scope, experienceId);
  if (history.version !== observedVersion)
    throw new Error('Experience changed; read it again before adopting');
  const previous = await requireRecord(db, scope, link.formed.id);
  if (practiceId && (previous.origin_task_id !== taskId || agentId !== 'growth_leader'))
    throw new ToolContractError('Practice belongs to another coordinator', {
      kind: 'invalid_request', effects: 'none', issues: [{ path: ['practice_ref'], message: 'Select a practice prepared by this Leader.' }],
      guidance: 'Read your saved practice reference; site history can be read but cannot be mutated as your practice.',
    });
  const result = await commitRecords(
    db,
    scope,
    operationId,
    input,
    [{ previous, data: JSON.parse(previous.data_json) }],
    [
      db
        .prepare(
          `insert into learning_uses(practice_id,experience_id,task_id,agent_id,observed_version,reason,compatibility,created_at) values(?,?,?,?,?,?,?,?)
      on conflict(practice_id,experience_id,task_id) do update set observed_version=excluded.observed_version,reason=excluded.reason,compatibility=excluded.compatibility`,
        )
        .bind(
          previous.id,
          experienceId,
          taskId,
          agentId,
          observedVersion,
          reason,
          compatibility,
          now(),
        ),
    ],
  );
  return { ...result, adopted: true };
}

/** Preparation alone has a finite recovery allowance. Receipts survive host replacement. */
export async function recordPreparationFailure(
  db: D1Database,
  scope: LearningScope,
  request: LearningRequest,
  receipt: string,
  message: string,
  permanent = false,
) {
  if (request.phase !== 'prepare') return false;
  const current = await db
    .prepare('select status from learning_requests where id=?')
    .bind(request.id)
    .first<{ status: string }>();
  if (current?.status === 'completed') return false;
  if (current?.status === 'skipped') return true;
  const at = now();
  await db.batch([
    db
      .prepare(
        'insert or ignore into learning_failures(request_id,receipt,message,created_at) values(?,?,?,?)',
      )
      .bind(request.id, receipt, message.slice(0, 1000), at),
    db
      .prepare(
        'update learning_requests set failure_count=(select count(*) from learning_failures where request_id=?),error=?,updated_at=? where id=?',
      )
      .bind(request.id, message.slice(0, 1000), at, request.id),
  ]);
  const failures = await db
    .prepare('select failure_count from learning_requests where id=?')
    .bind(request.id)
    .first<{ failure_count: number }>();
  if (!permanent && failures!.failure_count < 3) return false;
  const previous = await requireRecord(db, scope, request.record_id),
    data: LearningData = JSON.parse(previous.data_json);
  if (data.experience.preparation === 'ready') return false;
  data.experience.preparation = 'skipped';
  data.experience.gaps = [
    'Learning preparation unavailable; business continued without recalled experience or a pre-action evaluation.',
  ];
  await commitRecords(
    db,
    scope,
    `skip:${request.id}`,
    { request: request.id },
    [{ previous, data, status: 'incomplete' }],
    [
      db
        .prepare(
          "update learning_requests set status='skipped',updated_at=? where id=?",
        )
        .bind(at, request.id),
    ],
  );
  return true;
}
