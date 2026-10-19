import type { D1Database } from '@cloudflare/workers-types';
import { runtimeJson } from './protocol';
import { getAgentRun } from './store';

export type AgentMemory = {
  id: string;
  workspace_id: string;
  site_id: string;
  agent_id: string;
  kind: string;
  version: number;
  content_json: string;
  evidence_refs_json: string;
  source_run_id: string;
  supersedes_memory_id: string;
  created_at: string;
};

export async function appendEvidenceMemory(db: D1Database, input: {
  workspaceId: string; siteId: string; agentId: string; kind: string;
  content: unknown; evidenceRefs: string[]; sourceRunId: string; supersedesMemoryId?: string;
}): Promise<AgentMemory> {
  if (!input.evidenceRefs.length) throw new Error('Agent memory requires evidence references');
  const run = await getAgentRun(db, input.sourceRunId);
  if (!run || run.status !== 'succeeded' || run.workspace_id !== input.workspaceId || run.site_id !== input.siteId || run.agent_id !== input.agentId) {
    throw new Error('Agent memory source run is invalid');
  }
  const replay = await db.prepare('select * from agent_memories where source_run_id = ? and kind = ?')
    .bind(input.sourceRunId, input.kind)
    .first<AgentMemory>();
  if (replay) return replay;
  const previous = await db.prepare(
    'select * from agent_memories where workspace_id = ? and site_id = ? and agent_id = ? and kind = ? order by version desc limit 1',
  ).bind(input.workspaceId, input.siteId, input.agentId, input.kind).first<AgentMemory>();
  if (input.supersedesMemoryId && previous?.id !== input.supersedesMemoryId) throw new Error('Agent memory supersedes target is not latest');
  const memory: AgentMemory = {
    id: crypto.randomUUID(), workspace_id: input.workspaceId, site_id: input.siteId, agent_id: input.agentId,
    kind: input.kind, version: (previous?.version || 0) + 1, content_json: runtimeJson(input.content),
    evidence_refs_json: runtimeJson(input.evidenceRefs), source_run_id: input.sourceRunId,
    supersedes_memory_id: input.supersedesMemoryId || '', created_at: new Date().toISOString(),
  };
  try {
    await db.prepare(
    `insert into agent_memories (
      id, workspace_id, site_id, agent_id, kind, version, content_json, evidence_refs_json,
      source_run_id, supersedes_memory_id, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(...Object.values(memory)).run();
  } catch (error) {
    const winner = await db.prepare('select * from agent_memories where source_run_id = ? and kind = ?')
      .bind(input.sourceRunId, input.kind)
      .first<AgentMemory>();
    if (winner) return winner;
    throw error;
  }
  return memory;
}

export async function listAgentMemories(
  db: D1Database,
  workspaceId: string,
  siteId: string,
  agentId: string,
  agentInstanceId?: string,
): Promise<AgentMemory[]> {
  const { results } = await db.prepare(
    `select m.* from agent_memories m
     ${agentInstanceId ? 'join agent_runs r on r.id = m.source_run_id' : ''}
     where m.workspace_id = ? and m.site_id = ? and m.agent_id = ?
     ${agentInstanceId ? 'and r.agent_instance_id = ?' : ''}
     order by kind asc, version desc limit 200`,
  ).bind(...(agentInstanceId ? [workspaceId, siteId, agentId, agentInstanceId] : [workspaceId, siteId, agentId])).all<AgentMemory>();
  return results ?? [];
}
