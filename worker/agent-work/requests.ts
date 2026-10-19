import type { WorkNode } from '../../shared/agent-work';
import type { WorkRequestContext } from './contracts';
import type { TeamScope } from '../team-status/signals';
import { redactRuntimeValuePreservingSize } from '../agent-runtime/protocol';

/** The caller supplies its execution-scoped DB when creating from an Agent tool.
 * Request IDs and versions are host-owned; a saved version is immutable.
 * Domain handlers still authorize and reconcile their business effects.
 */
export async function createWorkRequest(context: WorkRequestContext, handlerId: string, node: WorkNode): Promise<void> {
  const interaction = node.interaction;
  if (!handlerId || !interaction || interaction.state !== 'pending' || !interaction.version || !interaction.id.startsWith(`${handlerId}:`) || node.id !== interaction.id) throw new Error('Invalid work request identity');
  if (!node.title.trim() || !node.at || !interaction.actions.length) throw new Error('Work request requires a title, timestamp and actions');
  const fieldIds = new Set(interaction.fields.map(field => field.id));
  if (fieldIds.size !== interaction.fields.length || new Set(interaction.actions.map(action => action.id)).size !== interaction.actions.length
    || interaction.actions.some(action => action.required_fields?.some(id => !fieldIds.has(id)))) throw new Error('Invalid work request fields or actions');
  const encoded = JSON.stringify(redactRuntimeValuePreservingSize({ ...node, state: 'attention' }));
  const result = await context.db.prepare(`insert or ignore into agent_work_requests(task_id,request_id,handler_id,version,state,node_json,created_at,updated_at)
    select id,?,?,?,'pending',?,?,? from agent_tasks where id=? and workspace_id=? and site_id=? and agent_id=? and status!='cancelled'`)
    .bind(interaction.id, handlerId, interaction.version, encoded, node.at, node.at, context.task.id, context.workspaceId, context.siteId, context.task.agent_id).run();
  if (result.meta.changes) return;
  const existing = await context.db.prepare(`select r.node_json,r.handler_id,r.version from agent_work_requests r join agent_tasks t on t.id=r.task_id
    where r.task_id=? and r.request_id=? and t.workspace_id=? and t.site_id=? and t.agent_id=?`)
    .bind(context.task.id, interaction.id, context.workspaceId, context.siteId, context.task.agent_id).first<{ node_json: string; handler_id: string; version: string }>();
  if (!existing || existing.handler_id !== handlerId || existing.version !== interaction.version || existing.node_json !== encoded) throw new Error('Work request identity already exists or task is unavailable');
}

export async function storedWorkNodes(context: WorkRequestContext): Promise<WorkNode[]> {
  const rows = await context.db.prepare(`select r.node_json,case when t.status='cancelled' then 'resolved' else r.state end as state from agent_work_requests r join agent_tasks t on t.id=r.task_id
    where t.id=? and t.workspace_id=? and t.site_id=? and t.agent_id=? order by r.created_at,r.request_id`)
    .bind(context.task.id, context.workspaceId, context.siteId, context.task.agent_id).all<{ node_json: string; state: 'pending' | 'resolved' }>();
  return rows.results.map(row => {
    const node = JSON.parse(row.node_json) as WorkNode;
    return row.state === 'pending' ? node : { ...node, state: 'resolved', interaction: { ...node.interaction!, state: 'resolved', actions: [] } };
  });
}

export async function storedPendingWork(scope: TeamScope, agentId: string) {
  const rows = await scope.db.prepare(`select r.task_id,r.request_id,json_extract(r.node_json,'$.title') as label,r.created_at as at
    from agent_work_requests r join agent_tasks t on t.id=r.task_id where t.workspace_id=? and t.site_id=? and t.agent_id=? and r.state='pending' and t.status!='cancelled'`)
    .bind(scope.workspaceId, scope.siteId, agentId).all<{ task_id: string; request_id: string; label: string; at: string }>();
  return rows.results;
}

/** Resolve only the observed request version, in the same transaction as its response receipt. */
export function resolveWorkRequestStatement(context: WorkRequestContext, requestId: string, version: string, command?: { id: string; leaseId: string }) {
  return context.db.prepare(`update agent_work_requests set state='resolved',updated_at=? where task_id=? and request_id=? and version=?
    and exists(select 1 from agent_tasks where id=task_id and workspace_id=? and site_id=?)
    ${command ? "and exists(select 1 from agent_work_responses r where r.command_id=? and r.task_id=agent_work_requests.task_id and r.lease_id=? and r.receipt_json!='')" : ''}`)
    .bind(new Date().toISOString(), context.task.id, requestId, version, context.workspaceId, context.siteId, ...(command ? [command.id, command.leaseId] : []));
}

/** The owning domain may withdraw a request after reconciling its external outcome. */
export async function resolveWorkRequest(context: WorkRequestContext, requestId: string, version: string): Promise<void> {
  const result = await resolveWorkRequestStatement(context, requestId, version).run();
  if (!result.meta.changes) throw new Error('Work request is missing or its version changed');
}
