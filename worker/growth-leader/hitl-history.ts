import type { D1Database } from '@cloudflare/workers-types';
import type { WorkNode, WorkResponse, WorkResponseReceipt } from '../../shared/agent-work';
import { workInteractions } from '../agent-work';
import type { AgentTask } from '../agent-runtime/task-store';

/** Leader-only presentation of its saved HITL requests and submitted replies. */
export async function readLeaderHitlHistory(db: D1Database, task: AgentTask): Promise<WorkNode[]> {
  const nodes = (await workInteractions({ db, workspaceId: task.workspace_id, siteId: task.site_id, task }))
    .filter(node => node.interaction?.spec);
  if (!nodes.length) return [];
  const rows = await db.prepare(`select request_id,version,input_json,receipt_json,created_at from agent_work_responses
    where task_id=? and request_id like 'hitl:%' and receipt_json!='' order by created_at,command_id`)
    .bind(task.id).all<{ request_id: string; version: string; input_json: string; receipt_json: string; created_at: string }>();
  const replies = new Map(rows.results.map(row => [`${row.request_id}:${row.version}`, row]));
  return nodes.map(node => {
    const interaction = node.interaction!;
    const row = replies.get(`${interaction.id}:${interaction.version}`);
    if (!row) return node;
    const input = JSON.parse(row.input_json) as WorkResponse;
    const receipt = JSON.parse(row.receipt_json) as WorkResponseReceipt;
    return { ...node, interaction: { ...interaction, response: {
      label: interaction.spec!.actions.find(action => action.id === input.action)?.label || input.action,
      note: receipt.message,
      at: row.created_at,
      action: input.action,
      values: input.values,
      ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
    } } };
  });
}
