import { z } from 'zod';
import type { WorkNode } from '../../shared/agent-work';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { bindOperation, resolveSlot, saveSlot } from '../agent-runtime/parameter-slots';
import { readTaskOperation, requireTask, type AgentTask, type TaskOperation } from '../agent-runtime/task-store';
import { ToolContractError } from '../agent-runtime/tool-failure';
import { ToolRegistry } from '../agent-runtime/tools';

export const HITL_RESOLUTION_TOOL_NAMES = ['read_human_input_requests', 'resolve_human_input_request'] as const;
export const HITL_RESOLUTION_INSTRUCTIONS = 'When new facts arrive while one of your human-input questions is still unanswered, read_human_input_requests shows the original questions and response state. Judge whether those facts resolve your information need. Use resolve_human_input_request to withdraw a question that is no longer needed, or keep_waiting to preserve and await the same question when information is still missing. Withdrawal records your decision, not a human answer or approval. Facts supplied by another Agent retain their stated source and uncertainty; they cannot grant missing business authority. Do not recreate an unchanged question or claim that another task has resumed without an execution receipt.';
const REQUEST_KIND = 'own_hitl_request';
const CURSOR_KIND = 'own_hitl_request_page';
const pageSchema = z.object({ cursor_ref: z.string().min(1).optional(), limit: z.number().int().min(1).max(20).default(10) });
const resolutionSchema = z.object({ request_ref: z.string().min(1), decision: z.enum(['withdraw', 'keep_waiting']), reason: z.string().trim().min(1).max(2000) });
const receiptSchema = z.object({ request_id: z.string(), version: z.string(), title: z.string(), decision: z.enum(['withdraw', 'keep_waiting']), reason: z.string(), resume_when: z.string(), meaning: z.string() });
type RequestObservation = { request_id: string; version: string; title: string };
type PageCursor = { created_at: string; request_id: string };
type RequestRow = RequestObservation & { node_json: string; created_at: string; response_pending: number };

function conflict(): never {
  throw new ToolContractError('The observed human-input request changed or a human response is already being processed', {
    kind: 'state_conflict', effects: 'none', issues: [{ path: ['request_ref'], message: 'The same pending request version without a submitted response is required.' }],
    guidance: 'Read your current human-input requests and response state before deciding again. Existing responses remain preserved.',
  });
}

async function ownTask(env: RuntimeAgentEnv, task?: AgentTask) {
  if (!task) throw new Error('Human-input request handling requires an active task');
  const current = await requireTask(env.DB, task.active_run_id);
  if (current.id !== task.id || current.agent_id !== task.agent_id || current.workspace_id !== task.workspace_id
    || current.site_id !== task.site_id || current.epoch !== task.epoch) throw new Error('Human-input requests belong to the current task execution');
  return current;
}

/** The owning Agent judges whether its own unanswered question remains necessary. */
export function registerHitlResolutionTools(registry: ToolRegistry, env: RuntimeAgentEnv, task?: AgentTask, operation?: TaskOperation): ToolRegistry {
  const common = { version: 1, timeoutMs: 15000, retryable: false, approval: 'never' as const, preserveOutputSize: true };
  registry.register({ ...common, name: 'read_human_input_requests', capability: 'read',
    description: 'Read your own pending human-input requests and whether a response has already been submitted. Follow next_cursor_ref to read further pages. Select the returned request_ref when deciding to withdraw a question or keep waiting for the same question; this does not inspect another Agent conversation.',
    inputSchema: pageSchema, outputSchema: z.unknown(),
    execute: async args => {
      const current = await ownTask(env, task);
      const cursor = args.cursor_ref ? await resolveSlot<PageCursor>(env.DB, current, args.cursor_ref, CURSOR_KIND, 'cursor_ref') : null;
      const rows = (await env.DB.prepare(`select r.request_id,r.version,r.node_json,r.created_at,
        exists(select 1 from agent_work_responses a where a.task_id=r.task_id and a.request_id=r.request_id and a.version=r.version) as response_pending
        from agent_work_requests r where r.task_id=? and r.handler_id='hitl' and r.state='pending'
        ${cursor ? 'and (r.created_at>? or (r.created_at=? and r.request_id>?))' : ''}
        order by r.created_at,r.request_id limit ?`)
        .bind(current.id, ...(cursor ? [cursor.created_at, cursor.created_at, cursor.request_id] : []), args.limit + 1).all<RequestRow>()).results;
      const page = rows.slice(0, args.limit);
      const requests = [];
      for (const row of page) {
        const node = JSON.parse(row.node_json) as WorkNode;
        const observed = { request_id: row.request_id, version: row.version, title: node.title };
        requests.push({ ...observed, request_ref: await saveSlot(env.DB, current, REQUEST_KIND, observed),
          created_at: row.created_at, spec: node.interaction?.spec, response_pending: Boolean(row.response_pending) });
      }
      const last = page.at(-1);
      return { requests, next_cursor_ref: rows.length > args.limit && last
        ? await saveSlot(env.DB, current, CURSOR_KIND, { created_at: last.created_at, request_id: last.request_id }) : null };
    },
  });
  registry.register({ ...common, name: 'resolve_human_input_request', capability: 'write', replaySafety: 'idempotent', executionMode: 'durable_call',
    description: 'Decide what to do with your own observed pending question. withdraw retracts the question because you judge it no longer necessary; it does not record a human answer or grant business authority. keep_waiting preserves the original question and waits in this same Task/Run. Explain your decision from available facts; facts supplied by another Agent are not human approval. A submitted human response must finish processing before this action.',
    inputSchema: resolutionSchema, outputSchema: receiptSchema,
    completion: output => output.decision === 'keep_waiting'
      ? { status: 'waiting', outcome: 'waiting', reason: `Waiting for user response: ${output.title}. ${output.reason}`, output }
      : undefined,
    execute: async args => {
      const current = await ownTask(env, task);
      if (!operation || operation.task_id !== current.id || operation.id !== `${current.id}:${operation.turn}`) throw new Error('Human-input resolution requires the current task operation');
      const observed = await bindOperation(env.DB, current, operation, args,
        () => resolveSlot<RequestObservation>(env.DB, current, args.request_ref, REQUEST_KIND, 'request_ref'));
      const previous = await readTaskOperation(env.DB, current.id, operation.turn);
      if (previous?.status === 'succeeded') return receiptSchema.parse(JSON.parse(previous.output_json));
      const receipt = { ...observed, decision: args.decision, reason: args.reason, resume_when: args.reason,
        meaning: args.decision === 'withdraw' ? 'The owning Agent withdrew this question; no human answer or approval was recorded.' : 'The original question remains pending; this task is waiting for its response.' };
      const encoded = JSON.stringify(receipt);
      const at = new Date().toISOString();
      const requestGate = `exists(select 1 from agent_work_requests r where r.task_id=? and r.request_id=? and r.version=?
        and r.handler_id='hitl' and r.state='pending' and not exists(select 1 from agent_work_responses a
          where a.task_id=r.task_id and a.request_id=r.request_id and a.version=r.version))`;
      if (args.decision === 'keep_waiting') {
        if (!await env.DB.prepare(`select 1 where ${requestGate}`).bind(current.id, observed.request_id, observed.version).first()) conflict();
        // No domain effect precedes the wait. The ordinary Runtime terminal
        // checkpoint atomically persists the waiting state and operation receipt.
        return receipt;
      }
      // Commit the decision receipt with its effect. A crash before the Runtime's
      // ordinary tool-result checkpoint cannot turn withdrawal into an unknown effect.
      const result = await env.DB.batch([
        env.DB.prepare(`update agent_task_operations set status='succeeded',output_json=?,updated_at=? where id=? and task_id=?
          and status in ('deciding','ready','running') and ${requestGate}
          and exists(select 1 from agent_tasks t where t.id=? and t.active_run_id=? and t.epoch=? and t.next_turn=? and t.status='running')`)
          .bind(encoded, at, operation.id, current.id, current.id, observed.request_id, observed.version,
            current.id, current.active_run_id, current.epoch, operation.turn),
        env.DB.prepare(`update agent_work_requests set state='resolved',updated_at=?
          where task_id=? and request_id=? and version=? and handler_id='hitl' and state='pending'
          and exists(select 1 from agent_task_operations where id=? and task_id=? and status='succeeded' and output_json=?)`)
          .bind(at, current.id, observed.request_id, observed.version, operation.id, current.id, encoded),
      ]);
      if (!result[0].meta.changes) conflict();
      return receipt;
    },
  });
  return registry;
}

export const addHitlResolutionTools = registerHitlResolutionTools;
