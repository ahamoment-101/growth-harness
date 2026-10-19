import { z } from 'zod';
import { hitlSpecSchema } from '../../shared/hitl';
import { createWorkRequest } from './requests';
import { hitlWorkNode } from './hitl-node';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import type { AgentTask, TaskOperation } from '../agent-runtime/task-store';
import type { RuntimeTool } from '../agent-runtime/tools';

export const HITL_TOOL_NAME = 'request_human_input';
export const HITL_AGENT_INSTRUCTIONS = 'When a decision-critical business fact is absent from available records and further autonomous work cannot resolve it, call request_human_input to compose a specific inline request. Complete independent work first. Human responses provide information for your next decision; they never grant publication or other business authority. Do not use this tool for execution failures, permission errors, or ordinary task handoffs.';
const inputSchema = z.object({ spec: hitlSpecSchema, resume_when: z.string().trim().min(1).max(500) });
const outputSchema = z.object({ request_id: z.string(), title: z.string(), resume_when: z.string() });

/** Shared input request mechanism; the owning Agent decides whether and what to ask. */
export function hitlTool(env: RuntimeAgentEnv, task?: AgentTask, operation?: TaskOperation): RuntimeTool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> {
  return {
    name: HITL_TOOL_NAME, version: 1, capability: 'write', replaySafety: 'idempotent',
    executionMode: 'durable_call', timeoutMs: 15_000, retryable: false, approval: 'never', preserveOutputSize: true,
    description: 'Ask the business user for a missing decision-critical fact. Compose the inline HITL view from text, notice, reference, choice and input blocks and response actions. Use only after checking available business records and completing unaffected work. Every action only records human input; it does not approve, publish or execute a business change. This waits and resumes the same Task and Run after the user responds.',
    inputSchema, outputSchema,
    completion: output => ({ status: 'waiting', outcome: 'waiting', reason: `Waiting for user response: ${output.title}. ${output.resume_when}`, output }),
    execute: async (args) => {
      if (!task || !operation) throw new Error('HITL requires an active task decision');
      const at = await env.DB.prepare('select created_at from agent_task_operations where id=? and task_id=?').bind(operation.id, task.id).first<{ created_at: string }>();
      if (!at?.created_at) throw new Error('HITL operation timestamp missing');
      const requestId = `hitl:${operation.id}`;
      const node = hitlWorkNode(requestId, at.created_at, args.spec);
      await createWorkRequest({ db: env.DB, workspaceId: task.workspace_id, siteId: task.site_id, task }, 'hitl', node);
      return { request_id: requestId, title: node.title, resume_when: args.resume_when };
    },
  };
}
