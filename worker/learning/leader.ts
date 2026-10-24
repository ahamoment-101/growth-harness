import { z } from 'zod';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from '../agent-runtime/env';
import { requireTask, type AgentTask, type TaskOperation } from '../agent-runtime/task-store';
import { bindOperation } from '../agent-runtime/parameter-slots';
import { ToolContractError } from '../agent-runtime/tool-failure';
import type { ToolRegistry } from '../agent-runtime/tools';
import { listBusinessModules } from '../lib/business';
import { LEADER_LEARNING_VERSION } from './business';
import { addEvidence, createPractice, now, recordDetail, requireRecord, type LearningRequest } from './store';

export const LEADER_LEARNING_TOOLS = ['prepare_business_practice', 'record_business_practice'] as const;
export const LEADER_LEARNING_INSTRUCTIONS = `You are the business team's sole interface to site-shared learning. Before starting a business practice worth learning from, use prepare_business_practice with the user's goal and available facts. It returns a durable practice_ref and a pre-action evaluation or an explicit preparation gap. A practice is an outcome-oriented initiative, not this whole conversation or each delegated task. Reuse its practice_ref for related delegations; prepare a new practice for a distinct initiative. Discussions need no practice. Do not backfill pre-action judgments for work already done.
Read site history using find_business_experience and read_business_experience. Only when an experience changes your decision, save adopt_business_experience with practice_ref and your own observed experience_ref; explain the actual change and compatibility. Reading or recommendations alone are not adoption. Put the concrete business guidance in delegate_task.context and pass practice_ref separately. Specialists receive ordinary business assignments and return formal deliverables; never ask them to call learning tools, score experience, or reveal internal conversations.
On receiving formal reports, use record_business_practice to summarize consequential adjustments, actual deliveries, limitations and your coordination decisions, citing the linked task refs. Read the practice's formal evidence to verify what was implemented. A saved adoption is your decision, not proof that specialists followed it or that it caused success. Publication and delayed measurements are captured independently. Unknown results remain unknown; never change the frozen evaluation after seeing outcomes. Utility is computed from compatible subsequent outcomes, not by you. Learning preparation may report unavailable after its recovery allowance; continue the authorized business work with that gap and retain the practice reference. Other Leader conversations may read these experiences but cannot modify this conversation's practice.`;

const scopeOf = (task: AgentTask) => ({ workspaceId: task.workspace_id, siteId: task.site_id });
export const leaderOwnsLearning = (task: AgentTask) => task.agent_id === 'growth_leader' && task.definition_version >= LEADER_LEARNING_VERSION;
function invalid(message: string): never {
  throw new ToolContractError(message, { kind: 'invalid_request', effects: 'none',
    issues: [{ path: ['practice_ref'], message }], guidance: 'Use the saved practice_ref from this Leader preparation. Keep unknown or unavailable learning explicit.' });
}

export async function requireLeaderPractice(env: RuntimeAgentEnv, task: AgentTask, id: string) {
  const row = await requireRecord(env.DB, scopeOf(task), id);
  if (!leaderOwnsLearning(task) || row.origin_task_id !== task.id) invalid('Practice was not prepared by this Leader');
  return row;
}

export function addLeaderLearningTools(registry: ToolRegistry, env: RuntimeAgentEnv, step: RuntimeWorkflowStep, task: AgentTask, operation?: TaskOperation) {
  if (!leaderOwnsLearning(task)) return registry;
  const common = { version: 1, approval: 'never' as const, capability: 'write' as const,
    replaySafety: 'idempotent' as const, timeoutMs: 60_000, retryable: false, outputSchema: z.unknown() };
  registry.register({ ...common, name: 'prepare_business_practice', executionMode: 'durable_call',
    description: 'Prepare learning before a business initiative. Returns its stable practice_ref and evaluation, or an explicit gap after recovery. Related delegations reuse this reference; a distinct initiative gets a new preparation.',
    inputSchema: z.object({ goal: z.string().min(1), context: z.string() }),
    execute: async args => {
      if (!operation) throw new Error('Preparation requires a durable operation');
      const bound = await bindOperation(env.DB, task, operation, args, async () => ({
        id: `practice:${operation.id}`, material: { goal: args.goal, context: args.context,
          business_documents: await listBusinessModules(env.DB, task.site_id) },
      }));
      const row = await createPractice(env.DB, scopeOf(task), task.id, task.agent_id, args.goal, bound);
      for (let poll = 0; ; poll++) {
        await requireTask(env.DB, task.active_run_id);
        const request = await env.DB.prepare('select * from learning_requests where id=?').bind(`prepare:${row.id}`).first<LearningRequest>();
        if (!request) throw new Error('Saved learning preparation is missing');
        if (['completed', 'skipped', 'failed'].includes(request.status)) {
          return { practice_ref: row.id, preparation_status: request.status, error: request.error,
            ...await recordDetail(env.DB, scopeOf(task), row.id) };
        }
        await step.sleep(`leader-learning:${row.id}:${poll}`, '5 seconds');
      }
    },
  });
  registry.register({ ...common, name: 'record_business_practice',
    description: 'Record the Leader’s consequential decisions and delivery assessment for its practice. Cite linked task refs; formal reports and publication receipts remain the evidence. Does not score outcomes or rewrite the pre-action agreement.',
    inputSchema: z.object({ practice_ref: z.string().min(1), summary: z.string().min(1), task_refs: z.array(z.string()) }),
    execute: async args => {
      if (!operation) throw new Error('Recording requires a durable operation');
      const bound = await bindOperation(env.DB, task, operation, args, async () => {
        await requireLeaderPractice(env, task, args.practice_ref);
        for (const id of args.task_refs) {
          const linked = await env.DB.prepare('select task_id from learning_tasks where record_id=? and task_id=?').bind(args.practice_ref, id).first();
          if (!linked) invalid(`Task ${id} is not linked to this practice`);
        }
        return args;
      });
      await addEvidence(env.DB, scopeOf(task), bound.practice_ref, `leader-record:${operation.id}`, 'feedback', task.id,
        { summary: bound.summary, task_refs: bound.task_refs, agent_id: task.agent_id, evidence_kind: 'leader_assessment' });
      return { recorded: true, practice_ref: bound.practice_ref };
    },
  });
  return registry;
}

/** Bind before child creation so fast completions and interrupted dispatch cannot lose evidence. */
export async function bindLearningDelegation(env: RuntimeAgentEnv, task: AgentTask, operation: TaskOperation, recordId?: string | null) {
  if (!leaderOwnsLearning(task)) return null;
  const saved = await env.DB.prepare('select * from learning_delegations where operation_id=?').bind(operation.id)
    .first<{ record_id: string; leader_task_id: string; guidance_json: string }>();
  if (saved) {
    if (saved.leader_task_id !== task.id || (recordId && saved.record_id !== recordId)) invalid('Delegation already belongs to another practice');
    return { practice_ref: saved.record_id, guidance: JSON.parse(saved.guidance_json) as string[] };
  }
  if (!recordId) return null;
  const row = await requireLeaderPractice(env, task, recordId);
  if (JSON.parse(row.data_json).experience.preparation === 'pending') invalid('Learning preparation is still pending');
  const uses = await env.DB.prepare('select reason from learning_uses where practice_id=? and task_id=? order by experience_id').bind(recordId, task.id).all<{ reason: string }>();
  const guidance = uses.results.map(r => r.reason);
  // Same host-owned child identity as dispatchChildTask; no Agent-supplied child ID.
  await env.DB.prepare('insert or ignore into learning_delegations(operation_id,leader_task_id,record_id,child_run_id,guidance_json,created_at) values(?,?,?,?,?,?)')
    .bind(operation.id, task.id, recordId, `child-${task.id}-${operation.turn}`, JSON.stringify(guidance), now()).run();
  return { practice_ref: recordId, guidance };
}

export async function topicPractice(env: RuntimeAgentEnv, task: AgentTask, groupId: string) {
  if (!leaderOwnsLearning(task)) return null;
  return (await env.DB.prepare(`select l.record_id from topic_decision_results g join agent_tasks t on t.active_run_id=g.run_id
    join learning_tasks l on l.task_id=t.id join learning_records r on r.id=l.record_id
    where g.id=? and g.workspace_id=? and g.site_id=? and r.origin_task_id=?`)
    .bind(groupId, task.workspace_id, task.site_id, task.id).first<{ record_id: string }>())?.record_id || null;
}

export async function contentPractice(env: RuntimeAgentEnv, task: AgentTask, groupId: string) {
  if (!leaderOwnsLearning(task)) return null;
  const linked = await env.DB.prepare(`select l.record_id from content_production_groups g join agent_tasks t on t.active_run_id=g.parent_run_id
    join learning_tasks l on l.task_id=t.id join learning_records r on r.id=l.record_id
    where g.id=? and g.workspace_id=? and g.site_id=? and r.origin_task_id=?`)
    .bind(groupId, task.workspace_id, task.site_id, task.id).first<{ record_id: string }>();
  if (linked) return linked.record_id;
  const group = await env.DB.prepare('select decision_group_id from content_production_groups where id=? and workspace_id=? and site_id=?')
    .bind(groupId, task.workspace_id, task.site_id).first<{ decision_group_id: string }>();
  return group ? topicPractice(env, task, group.decision_group_id) : null;
}
