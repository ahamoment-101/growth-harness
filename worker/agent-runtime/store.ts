import type { D1Database } from '@cloudflare/workers-types';
import type { AgentEvent, AgentRun, AgentRunStatus } from './protocol';
import { canTransitionAgentRun, runtimeJson } from './protocol';

export type CreateAgentRunInput = {
  id: string;
  workspaceId: string;
  siteId: string;
  agentId: string;
  instanceId?: string;
  definitionVersion: number;
  promptVersion: string;
  trigger: string;
  scheduleKey?: string;
  parentRunId?: string;
  rootRunId?: string;
  retryOfRunId?: string;
  summary?: unknown;
  at?: string;
};

export async function createAgentRun(db: D1Database, input: CreateAgentRunInput): Promise<AgentRun> {
  const at = input.at ?? new Date().toISOString();
  await db.prepare(
    `insert into agent_runs (
      id, workspace_id, site_id, agent_id, agent_instance_id, definition_version, prompt_version,
      trigger, schedule_key, status, phase, root_run_id, parent_run_id, retry_of_run_id, summary_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.workspaceId,
    input.siteId,
    input.agentId,
    input.instanceId || '',
    input.definitionVersion,
    input.promptVersion,
    input.trigger,
    input.scheduleKey || '',
    input.rootRunId || input.id,
    input.parentRunId || '',
    input.retryOfRunId || '',
    runtimeJson(input.summary ?? {}),
    at,
    at,
  ).run();
  const run = await getAgentRun(db, input.id);
  if (!run) throw new Error('Agent run was not created');
  return run;
}

export function getAgentRun(db: D1Database, runId: string): Promise<AgentRun | null> {
  return db.prepare('select * from agent_runs where id = ?').bind(runId).first<AgentRun>();
}

export function getAgentRunByWorkflowId(db: D1Database, workflowId: string): Promise<AgentRun | null> {
  if (!workflowId) return Promise.resolve(null);
  return db.prepare('select * from agent_runs where workflow_id = ? order by created_at desc limit 1')
    .bind(workflowId)
    .first<AgentRun>();
}

export async function getActiveAgentRun(db: D1Database, workspaceId: string, siteId: string, agentId: string, instanceId = ''): Promise<AgentRun | null> {
  return db.prepare(
    `select * from agent_runs
     where workspace_id = ? and site_id = ? and agent_id = ? and agent_instance_id = ?
       and status in ('queued', 'running', 'waiting_for_approval', 'waiting_for_input')
     order by created_at desc limit 1`,
  ).bind(workspaceId, siteId, agentId, instanceId).first<AgentRun>();
}

export function getScheduledAgentRun(
  db: D1Database,
  workspaceId: string,
  siteId: string,
  agentId: string,
  scheduleKey: string,
): Promise<AgentRun | null> {
  return db.prepare(
    `select * from agent_runs where workspace_id = ? and site_id = ? and agent_id = ? and schedule_key = ? limit 1`,
  ).bind(workspaceId, siteId, agentId, scheduleKey).first<AgentRun>();
}

export async function transitionAgentRun(
  db: D1Database,
  runId: string,
  status: AgentRunStatus,
  patch: { phase?: string; workflowId?: string; errorCode?: string; error?: string; output?: unknown; summary?: unknown } = {},
  at = new Date().toISOString(),
): Promise<AgentRun> {
  const current = await getAgentRun(db, runId);
  if (!current) throw new Error('Agent run not found');
  if (!canTransitionAgentRun(current.status, status)) throw new Error(`Invalid agent run transition: ${current.status} -> ${status}`);
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);
  const startedAt = status === 'running' && !current.started_at ? at : current.started_at;
  const result = await db.prepare(
    `update agent_runs set
      status = ?, phase = ?, workflow_id = ?, error_code = ?, error = ?,
      output_json = ?, summary_json = ?, started_at = ?, finished_at = ?, updated_at = ?
     where id = ? and status = ?`,
  ).bind(
    status,
    patch.phase ?? current.phase,
    patch.workflowId ?? current.workflow_id,
    patch.errorCode ?? current.error_code,
    patch.error ? String(patch.error).slice(0, 1000) : current.error,
    patch.output === undefined ? current.output_json : runtimeJson(patch.output),
    patch.summary === undefined ? current.summary_json : runtimeJson(patch.summary),
    startedAt,
    terminal ? at : current.finished_at,
    at,
    runId,
    current.status,
  ).run();
  if (!result.meta.changes) throw new Error('Agent run changed concurrently');
  return (await getAgentRun(db, runId))!;
}

export async function recordAgentEvent(
  db: D1Database,
  input: {
    runId: string;
    eventKey: string;
    kind: string;
    phase: string;
    actorType: AgentEvent['actor_type'];
    actorId?: string;
    payload?: unknown;
    at?: string;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  const at = input.at ?? new Date().toISOString();
  await db.batch([
    db.prepare(
      `insert or ignore into agent_events (
        id, run_id, seq, event_key, kind, phase, actor_type, actor_id, payload_json, created_at
      ) select ?, id, event_seq + 1, ?, ?, ?, ?, ?, ?, ? from agent_runs where id = ?`,
    ).bind(id, input.eventKey, input.kind, input.phase, input.actorType, input.actorId || '', runtimeJson(input.payload ?? {}), at, input.runId),
    db.prepare(
      `update agent_runs
       set event_seq = event_seq + 1, updated_at = ?
       where id = ? and exists (
         select 1 from agent_events
         where run_id = agent_runs.id and event_key = ? and seq = agent_runs.event_seq + 1
       )`,
    ).bind(at, input.runId, input.eventKey),
  ]);
}

export async function appendAgentEvent(
  db: D1Database,
  input: {
    runId: string;
    eventKey: string;
    kind: string;
    phase: string;
    actorType: AgentEvent['actor_type'];
    actorId?: string;
    payload?: unknown;
    at?: string;
  },
): Promise<AgentEvent> {
  await recordAgentEvent(db, input);
  const event = await db.prepare('select * from agent_events where run_id = ? and event_key = ?')
    .bind(input.runId, input.eventKey)
    .first<AgentEvent>();
  if (!event) throw new Error('Agent event was not appended');
  return event;
}

export async function listAgentEvents(db: D1Database, runId: string, afterSeq = 0): Promise<AgentEvent[]> {
  const { results } = await db.prepare('select * from agent_events where run_id = ? and seq > ? order by seq asc limit 500')
    .bind(runId, afterSeq)
    .all<AgentEvent>();
  return results ?? [];
}

export async function listAgentRuns(db: D1Database, workspaceId: string, siteId: string, agentId: string, limit = 20): Promise<AgentRun[]> {
  const { results } = await db.prepare(
    `select * from agent_runs where workspace_id = ? and site_id = ? and agent_id = ?
     order by created_at desc limit ?`,
  ).bind(workspaceId, siteId, agentId, Math.max(1, Math.min(limit, 100))).all<AgentRun>();
  return results ?? [];
}

export async function listActiveChildRuns(db: D1Database, parentRunId: string): Promise<AgentRun[]> {
  const { results } = await db.prepare(
    `select * from agent_runs where parent_run_id = ?
     and status in ('queued', 'running', 'waiting_for_approval', 'waiting_for_input')
     order by created_at asc`,
  ).bind(parentRunId).all<AgentRun>();
  return results ?? [];
}
