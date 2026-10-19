/**
 * Where an Agent keeps what it is building.
 *
 * Every Agent that produces something substantial has the same problem: its
 * output has to survive across turns, but the only place it could put it was
 * the conversation, and a conversation is re-sent every turn and compacted when
 * it grows. So the more an Agent produced, the more likely it was to forget what
 * it had produced. Three Agents had each grown half of the fix — they persisted
 * a candidate, then rendered the whole thing back into the prompt anyway, which
 * is the half that mattered undone.
 *
 * A working draft is the other half: a place to write that costs nothing to
 * carry. The Agent's module reads it, renders a short outline of it into the
 * prompt, and fetches detail only when a decision needs it.
 *
 * ## What this layer knows, and what it must never know
 *
 * It knows identity, versions, isolation, replay safety and retention. It does
 * not know what is inside the document. A strategy draft holds territories and
 * clusters; an article draft holds prose and locale variants; a shared layer
 * that understood either would fit the first Agent to arrive and fight the
 * second. Shape, write actions, validation rules, the outline and the
 * definition of "finished" all belong to the Agent that owns the artifact.
 *
 * ## Not business truth
 *
 * A draft is Runtime state. D1's business tables stay authoritative: nothing a
 * draft contains is real until the owning Agent submits it through its own
 * persistence path. Losing a draft costs work, never correctness.
 */
import type { D1Database } from '@cloudflare/workers-types';
import { redactRuntimeValuePreservingSize } from './protocol';

export type WorkingDraftIdentity = {
  workspaceId: string;
  siteId: string;
  agentId: string;
  /** Distinguishes concurrent drafts of the same Agent — one per locale, per article. */
  instanceId?: string;
  /**
   * What makes this one continuous piece of work. The Run's `root_run_id`: a
   * continuation chain, a retry chain and their parent share it, so a successor
   * Run picks the draft up instead of starting over, while a genuinely new task
   * gets a new root and therefore a clean draft.
   */
  lineageId: string;
};

export type WorkingDraftStatus = 'drafting' | 'submitted' | 'abandoned';

export type WorkingDraft<T = unknown> = {
  id: string;
  version: number;
  status: WorkingDraftStatus;
  content: T;
  byteLength: number;
  lastWriteKey: string;
  lastRunId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Large enough for an article bundle with every locale, which is the biggest
 * artifact any Agent produces. Crossing it is a bug in the owning Agent — a
 * draft is one artifact, not an accumulating log — so it throws rather than
 * truncating: silently shortening the thing an Agent is building is how work
 * disappears without anyone noticing.
 */
export const WORKING_DRAFT_MAX_BYTES = 2_000_000;

function draftId(identity: WorkingDraftIdentity): string {
  return [
    identity.workspaceId, identity.siteId, identity.agentId,
    identity.instanceId || '', identity.lineageId,
  ].map((part) => encodeURIComponent(part)).join(':');
}

function assertIdentity(identity: WorkingDraftIdentity): void {
  if (!identity.workspaceId || !identity.siteId || !identity.agentId || !identity.lineageId) {
    throw new Error('Working draft identity is incomplete');
  }
}

function rowToDraft<T>(row: {
  id: string; version: number; status: string; content_json: string; byte_length: number;
  last_write_key: string; last_run_id: string; created_at: string; updated_at: string;
}): WorkingDraft<T> {
  return {
    id: row.id,
    version: Number(row.version || 0),
    status: row.status as WorkingDraftStatus,
    content: JSON.parse(row.content_json) as T,
    byteLength: Number(row.byte_length || 0),
    lastWriteKey: String(row.last_write_key || ''),
    lastRunId: String(row.last_run_id || ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  };
}

const SELECT_COLUMNS =
  'id, version, status, content_json, byte_length, last_write_key, last_run_id, created_at, updated_at';

/**
 * Reads the draft for this identity, or null when the lineage has not started
 * one. Every column of the identity is in the WHERE clause rather than checked
 * after the fetch, so one locale's draft can never be served to another.
 */
export async function readWorkingDraft<T = unknown>(
  db: D1Database,
  identity: WorkingDraftIdentity,
): Promise<WorkingDraft<T> | null> {
  assertIdentity(identity);
  const row = await db.prepare(
    `select ${SELECT_COLUMNS} from agent_working_drafts
     where workspace_id = ? and site_id = ? and agent_id = ? and agent_instance_id = ? and lineage_id = ?`,
  ).bind(
    identity.workspaceId, identity.siteId, identity.agentId,
    identity.instanceId || '', identity.lineageId,
  ).first<Parameters<typeof rowToDraft>[0]>();
  return row ? rowToDraft<T>(row) : null;
}

/**
 * Replaces the draft's content and returns the new version.
 *
 * `writeKey` is what makes this safe under durable replay. A step that executed
 * but never recorded its result runs again; without the key the second run would
 * append a second version of the same edit. Because no later step can have run
 * in that situation, comparing against the most recent write is sufficient — and
 * the key must be Run-scoped, so a successor Run deliberately redoing the same
 * stage is not mistaken for a replay of its predecessor.
 */
export async function writeWorkingDraft<T>(
  db: D1Database,
  input: {
    identity: WorkingDraftIdentity;
    writeKey: string;
    runId: string;
    content: T;
    status?: WorkingDraftStatus;
  },
): Promise<WorkingDraft<T>> {
  assertIdentity(input.identity);
  if (!input.writeKey.trim()) throw new Error('Working draft write requires a write key');
  const existing = await readWorkingDraft<T>(db, input.identity);
  if (existing && existing.lastWriteKey === input.writeKey) return existing;

  const contentJson = JSON.stringify(redactRuntimeValuePreservingSize(input.content));
  const byteLength = new TextEncoder().encode(contentJson).length;
  if (byteLength > WORKING_DRAFT_MAX_BYTES) {
    throw new Error(`Working draft exceeds the ${WORKING_DRAFT_MAX_BYTES} byte limit`);
  }
  const at = new Date().toISOString();
  const id = existing?.id || draftId(input.identity);
  const status = input.status || existing?.status || 'drafting';
  await db.prepare(
    `insert into agent_working_drafts
     (id, workspace_id, site_id, agent_id, agent_instance_id, lineage_id, version, status,
      content_json, byte_length, last_write_key, last_run_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
     on conflict(workspace_id, site_id, agent_id, agent_instance_id, lineage_id) do update set
       version = agent_working_drafts.version + 1,
       status = excluded.status,
       content_json = excluded.content_json,
       byte_length = excluded.byte_length,
       last_write_key = excluded.last_write_key,
       last_run_id = excluded.last_run_id,
       updated_at = excluded.updated_at`,
  ).bind(
    id, input.identity.workspaceId, input.identity.siteId, input.identity.agentId,
    input.identity.instanceId || '', input.identity.lineageId, status,
    contentJson, byteLength, input.writeKey, input.runId, at, at,
  ).run();
  const written = await readWorkingDraft<T>(db, input.identity);
  if (!written) throw new Error('Working draft was not written');
  return written;
}

/**
 * Marks a draft finished. Kept rather than deleted: after an Agent submits, the
 * draft is the record of how the artifact was actually built, which is the one
 * question the finished artifact cannot answer.
 */
export async function closeWorkingDraft(
  db: D1Database,
  identity: WorkingDraftIdentity,
  status: Exclude<WorkingDraftStatus, 'drafting'>,
): Promise<void> {
  assertIdentity(identity);
  await db.prepare(
    `update agent_working_drafts set status = ?, updated_at = ?
     where workspace_id = ? and site_id = ? and agent_id = ? and agent_instance_id = ? and lineage_id = ?`,
  ).bind(
    status, new Date().toISOString(), identity.workspaceId, identity.siteId,
    identity.agentId, identity.instanceId || '', identity.lineageId,
  ).run();
}

/** Drafts for one site, newest first. The console reads what is stored, as stored. */
export async function listWorkingDrafts(
  db: D1Database,
  input: { workspaceId: string; siteId: string; agentId?: string; limit?: number },
): Promise<Array<WorkingDraft<unknown> & { agentId: string; instanceId: string; lineageId: string }>> {
  const { results } = await db.prepare(
    `select ${SELECT_COLUMNS}, agent_id, agent_instance_id, lineage_id from agent_working_drafts
     where workspace_id = ? and site_id = ? and (? = '' or agent_id = ?)
     order by updated_at desc limit ?`,
  ).bind(
    input.workspaceId, input.siteId, input.agentId || '', input.agentId || '',
    Math.max(1, Math.min(input.limit || 20, 100)),
  ).all<Parameters<typeof rowToDraft>[0] & { agent_id: string; agent_instance_id: string; lineage_id: string }>();
  return (results ?? []).map((row) => ({
    ...rowToDraft(row),
    agentId: String(row.agent_id),
    instanceId: String(row.agent_instance_id || ''),
    lineageId: String(row.lineage_id),
  }));
}
