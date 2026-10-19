import { storedPendingWork, storedWorkNodes, resolveWorkRequestStatement } from './requests';
export { createWorkRequest, resolveWorkRequest } from './requests';
import { contentWorkProvider } from './content-provider';
import type { WorkNode, WorkResponse, WorkResponseReceipt } from '../../shared/agent-work';
import type { WorkProvider, WorkRequestContext } from './contracts';
import type { TeamScope } from '../team-status/signals';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { runtimeWorkProvider } from './runtime-provider';
import { hitlWorkProvider } from './hitl-provider';
import { topicWorkProvider } from './topic-provider';
import { redactRuntimeValuePreservingSize } from '../agent-runtime/protocol';
import { createHitlResponse } from '../../shared/hitl';

export const WORK_PROVIDERS: readonly WorkProvider[] = [runtimeWorkProvider, hitlWorkProvider, topicWorkProvider, contentWorkProvider];
const forAgent = (providers: readonly WorkProvider[], agentId: string) => providers.filter(provider => !provider.agents || provider.agents.includes(agentId));

export async function pendingWork(scope: TeamScope, agentId: string, providers = WORK_PROVIDERS) {
  const pending = [...await storedPendingWork(scope, agentId), ...(await Promise.all(forAgent(providers, agentId).map(provider => provider.pending?.(scope, agentId) ?? []))).flat()];
  // Driven by the unfinished-response index: responses in flight, never the Agent's task history.
  const unfinished = await scope.db.prepare(`select t.id as task_id,r.request_id,r.command_id,r.created_at as at from agent_work_responses r
    join agent_tasks t on t.id=r.task_id where +t.workspace_id=? and +t.site_id=? and +t.agent_id=? and r.receipt_json=''`)
    .bind(scope.workspaceId, scope.siteId, agentId).all<{ task_id: string; request_id: string; command_id: string; at: string }>();
  for (const item of unfinished.results) if (!pending.some(p => p.task_id === item.task_id && p.request_id === item.request_id)) pending.push({ ...item, request_id: `pending:${item.command_id}`, label: 'Response pending' });
  return pending;
}

export async function workInteractions(context: WorkRequestContext, providers = WORK_PROVIDERS): Promise<WorkNode[]> {
  const nodes = [...await storedWorkNodes(context), ...(await Promise.all(forAgent(providers, context.task.agent_id).map(provider => provider.read?.(context) ?? []))).flat()];
  const receipts = await context.db.prepare('select * from agent_work_responses where task_id=? order by created_at,command_id')
    .bind(context.task.id).all<{ command_id: string; request_id: string; version: string; input_json: string; node_json: string; receipt_json: string; created_at: string }>();
  for (const receipt of receipts.results) {
    const input = { ...JSON.parse(receipt.input_json), command_id: receipt.command_id } as WorkResponse;
    const snapshot = JSON.parse(receipt.node_json) as WorkNode;
    if (!receipt.receipt_json) {
      const node = nodes.find(node => node.interaction?.id === receipt.request_id && node.interaction.version === receipt.version);
      if (node?.interaction) {
        node.interaction.pending_submission = input;
      } else {
        nodes.push({ ...snapshot, id: `pending:${receipt.command_id}`, at: snapshot.at || receipt.created_at, title: snapshot.title || 'Verifying your response', state: 'attention',
          interaction: { ...snapshot.interaction, id: receipt.request_id, version: receipt.version, state: 'pending', fields: snapshot.interaction?.fields || [], actions: [], pending_submission: input } });
      }
      continue;
    }
    const saved = JSON.parse(receipt.receipt_json) as WorkResponseReceipt;
    if (snapshot.id && !nodes.some(node => node.id === snapshot.id)) nodes.push({ ...snapshot, state: 'resolved',
      interaction: snapshot.interaction ? { ...snapshot.interaction, state: 'resolved', actions: [], pending_submission: undefined } : undefined });
    nodes.push({ id: `response:${receipt.command_id}`, at: receipt.created_at, title: saved.outcome === 'superseded' ? 'This response was not executed' : 'Your response has been processed', state: 'resolved',
      body: [...Object.entries(input.values).filter(([, value]) => !!value).map(([key, value]) => `${snapshot.interaction?.fields.find(field => field.id === key)?.label || key}: ${value}`), saved.message].filter(Boolean).join('\n\n') });
  }
  return redactRuntimeValuePreservingSize(nodes) as WorkNode[];
}

/** The provider owns semantic validation and replay; this boundary binds scope, observed version and exact submitted values. */
export async function respondToWork(env: RuntimeAgentEnv, context: WorkRequestContext, input: WorkResponse, actorId: string, providers = WORK_PROVIDERS): Promise<WorkResponseReceipt> {
  if (context.task.workspace_id !== context.workspaceId || context.task.site_id !== context.siteId) throw new Error('Task does not belong to the current workspace or site');
  if (!input || typeof input.command_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.command_id)
    || typeof input.request_id !== 'string' || typeof input.version !== 'string' || typeof input.action !== 'string'
    || !input.values || Array.isArray(input.values) || typeof input.values !== 'object'
    || Object.values(input.values).some(value => typeof value !== 'string')) throw new Error('Invalid interaction response');
  const provider = forAgent(providers, context.task.agent_id).find(provider => input.request_id.startsWith(`${provider.id}:`));
  if (!provider) throw new Error('This interaction is not supported for this task');
  const encoded = JSON.stringify({ request_id: input.request_id, version: input.version, action: input.action, command_id: input.command_id, values: Object.fromEntries(Object.entries(input.values).sort(([a], [b]) => a.localeCompare(b))) });
  const previous = await context.db.prepare('select * from agent_work_responses where command_id=?').bind(input.command_id)
    .first<{ task_id: string; actor_id: string; input_json: string; receipt_json: string }>();
  if (previous) {
    if (previous.task_id !== context.task.id || previous.actor_id !== actorId || previous.input_json !== encoded) throw new Error('Response identity has already been used for something else');
    if (previous.receipt_json) return JSON.parse(previous.receipt_json);
  } else {
    const node = [...await storedWorkNodes(context), ...await (provider.read?.(context) ?? [])].find(node => node.interaction?.id === input.request_id);
    const interaction = node?.interaction;
    if (!interaction || interaction.state !== 'pending' || interaction.version !== input.version) throw new Error('Request has been updated or already processed, please refresh to view');
    const action = interaction.actions.find(action => action.id === input.action && !action.href);
    if (!action) throw new Error('This action is currently unavailable');
    for (const key of Object.keys(input.values)) if (!interaction.fields.some(field => field.id === key)) throw new Error('Contains undeclared input fields');
    for (const field of interaction.fields) {
      const value = input.values[field.id] || '';
      if (action.required_fields?.includes(field.id) && !value.trim()) throw new Error(`Please fill in ${field.label}`);
      if (field.max_length && value.length > field.max_length) throw new Error(`${field.label} is too long`);
      if (value && field.kind === 'select' && !field.options?.some(option => option.value === value)) throw new Error(`${field.label} option is invalid`);
    }
    if (interaction.spec) {
      const validated = createHitlResponse({ id: interaction.id, version: interaction.version, spec: interaction.spec }, input.action, input.values);
      const sorted = (values: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
      if (sorted(validated.values) !== sorted(input.values)) throw new Error('Contains input fields that are currently invisible');
      if (JSON.stringify({ type: 'hitl_response', ...validated }).length > 20_000) throw new Error('The HITL response is too long');
    }
    const claim = await context.db.prepare(`insert or ignore into agent_work_responses(command_id,task_id,request_id,version,actor_id,input_json,node_json,created_at) values(?,?,?,?,?,?,?,?)`)
      .bind(input.command_id, context.task.id, input.request_id, input.version, actorId, encoded, JSON.stringify(redactRuntimeValuePreservingSize(node)), new Date().toISOString()).run();
    if (!claim.meta.changes) throw new Error('A response for this request is already being processed, please refresh to view');
  }
  const leaseId = crypto.randomUUID();
  const now = new Date();
  const lock = await context.db.prepare(`update agent_work_responses set lease_id=?,lease_until=? where command_id=? and task_id=? and receipt_json='' and lease_until<=?`)
    .bind(leaseId, new Date(now.getTime() + 120000).toISOString(), input.command_id, context.task.id, now.toISOString()).run();
  if (!lock.meta.changes) throw new Error('This response is being processed, please refresh later');
  try {
    const receipt: WorkResponseReceipt = context.task.status === 'cancelled' && !provider.read
      ? { message: 'Task has been canceled, this response was not executed.', outcome: 'superseded' }
      : await provider.respond(env, context, input, actorId);
    await context.db.batch([context.db.prepare('update agent_work_responses set receipt_json=? where command_id=? and task_id=? and lease_id=?')
      .bind(JSON.stringify(receipt), input.command_id, context.task.id, leaseId), resolveWorkRequestStatement(context, input.request_id, input.version, { id: input.command_id, leaseId })]);
    return receipt;
  } finally {
    await context.db.prepare("update agent_work_responses set lease_id='',lease_until='' where command_id=? and lease_id=?").bind(input.command_id, leaseId).run();
  }
}
