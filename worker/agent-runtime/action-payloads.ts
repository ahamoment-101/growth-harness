import type { D1Database } from '@cloudflare/workers-types';
import { redactRuntimeValuePreservingSize } from './protocol';

export type AgentActionPayloadRef = {
  payload_ref: string;
  sha256: string;
  byte_length: number;
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function persistAgentActionPayload(db: D1Database, input: {
  runId: string;
  workspaceId: string;
  siteId: string;
  decisionTurn: number;
  toolName: string;
  direction: 'input' | 'output';
  status?: string;
  payload: unknown;
}): Promise<AgentActionPayloadRef> {
  const payloadJson = JSON.stringify(redactRuntimeValuePreservingSize(input.payload));
  const byteLength = new TextEncoder().encode(payloadJson).length;
  if (byteLength > 2_000_000) throw new Error('Agent action payload exceeds the 2000000 byte persistence limit');
  const digest = await sha256(payloadJson);
  const id = `${input.runId}:payload:${input.decisionTurn}:${input.toolName}:${input.direction}`;
  const at = new Date().toISOString();
  await db.prepare(
    `insert into agent_action_payloads
     (id, run_id, workspace_id, site_id, decision_turn, tool_name, direction, status,
      payload_json, sha256, byte_length, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(run_id, decision_turn, tool_name, direction) do update set
       status = excluded.status, payload_json = excluded.payload_json, sha256 = excluded.sha256,
       byte_length = excluded.byte_length, updated_at = excluded.updated_at`,
  ).bind(
    id, input.runId, input.workspaceId, input.siteId, input.decisionTurn, input.toolName,
    input.direction, input.status || 'working', payloadJson, digest, byteLength, at, at,
  ).run();
  return { payload_ref: id, sha256: digest, byte_length: byteLength };
}

export async function readAgentActionPayload(db: D1Database, input: {
  payloadRef: string;
  runId: string;
  workspaceId: string;
  siteId: string;
}): Promise<unknown | null> {
  const row = await db.prepare(
    `select payload_json from agent_action_payloads
     where id = ? and run_id = ? and workspace_id = ? and site_id = ?`,
  ).bind(input.payloadRef, input.runId, input.workspaceId, input.siteId).first<{ payload_json: string }>();
  return row ? JSON.parse(row.payload_json) : null;
}

export async function latestAgentActionPayload(db: D1Database, input: {
  runId: string;
  workspaceId: string;
  siteId: string;
  toolName: string;
  direction: 'input' | 'output';
}): Promise<{ payload_ref: string; payload: unknown } | null> {
  const row = await db.prepare(
    `select id, payload_json from agent_action_payloads
     where run_id = ? and workspace_id = ? and site_id = ? and tool_name = ? and direction = ?
     order by decision_turn desc limit 1`,
  ).bind(input.runId, input.workspaceId, input.siteId, input.toolName, input.direction)
    .first<{ id: string; payload_json: string }>();
  return row ? { payload_ref: row.id, payload: JSON.parse(row.payload_json) } : null;
}
