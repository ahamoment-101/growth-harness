import { z } from 'zod';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { resolveSlot } from '../agent-runtime/parameter-slots';
import { taskDataJson } from '../agent-runtime/task-store';
import type { AgentTask, TaskOperation } from '../agent-runtime/task-store';
import { ToolContractError } from '../agent-runtime/tool-failure';
import { bindLearningDelegation, requireLeaderPractice } from './leader';
import type { LearningData } from '../../shared/learning';
import { commitRecords, getRecord, now, replayOperation, requireRecord } from './store';

export const DELEGATED_EXPERIENCE_VERSION = 24;
export const delegatedExperienceUses = z.array(z.object({
  experience_ref: z.string().min(1).describe('Your own read_business_experience reference, not a search result or another Agent observation.'),
  reason: z.string().trim().min(1).describe('The concrete guidance you are applying in this assignment and what decision it changes. This is delivered to the specialist.'),
  compatibility: z.string().trim().min(1).describe('Why the lesson applies here, including relevant differences or uncertainty; this does not certify outcome comparability.'),
})).describe('Historical experiences actually informing this delegation. Pass [] when none apply. Saves adoption with the assignment; retrieval alone is not adoption.');

type ExperienceUse = z.infer<typeof delegatedExperienceUses>[number];

function invalid(path: Array<string | number>, message: string, conflict = false): never {
  throw new ToolContractError(message, {
    kind: conflict ? 'state_conflict' : 'invalid_request', effects: 'none',
    issues: [{ path, message }],
    guidance: 'No adoption or dispatch was saved by this attempt. Read the affected experience in this Leader, select a prepared practice and declare only guidance actually used. An empty experience_uses list is valid.',
  });
}

/** Domain decision receipt, committed before dispatch. Runtime still owns child authority and replay. */
export async function bindDelegatedExperienceUses(
  env: RuntimeAgentEnv, task: AgentTask, operation: TaskOperation,
  practiceId: string | null | undefined, uses: ExperienceUse[], decision: unknown,
) {
  const scope = { workspaceId: task.workspace_id, siteId: task.site_id };
  // Separate from dispatchChildTask's operation binding; bind the entire decision so
  // interrupted dispatch cannot reinterpret adoption against another assignment.
  const receipt = `delegated-experience:${operation.id}`;
  const input = { task_id: task.id, practice_id: practiceId || null, decision };
  if (await replayOperation(env.DB, scope, receipt, input)) {
    return bindLearningDelegation(env, task, operation, practiceId);
  }
  if (!practiceId) {
    if (uses.length) invalid(['practice_ref'], 'Experience adoption requires a prepared practice');
    // Even an explicit non-learning assignment freezes this decision: a replay
    // must not add adoption before dispatch notices that its original input changed.
    try {
      await env.DB.prepare('insert into learning_operations(id,workspace_id,site_id,input_json,result_json,created_at) values(?,?,?,?,?,?)')
        .bind(receipt, scope.workspaceId, scope.siteId, taskDataJson(input), JSON.stringify({ record_id: '', version: 0 }), now()).run();
    } catch (error) {
      if (!await replayOperation(env.DB, scope, receipt, input)) throw error;
    }
    return null;
  }
  const previous = await requireLeaderPractice(env, task, practiceId);
  const data: LearningData = JSON.parse(previous.data_json);
  if (data.experience.preparation === 'pending') invalid(['practice_ref'], 'Learning preparation is still pending');
  const resolved = [];
  const seen = new Set<string>();
  for (const [index, use] of uses.entries()) {
    const observed = await resolveSlot<{ id: string; version: number }>(env.DB, task, use.experience_ref, 'business_experience', `experience_uses.${index}.experience_ref`);
    const history = await requireRecord(env.DB, scope, observed.id);
    const path = ['experience_uses', index, 'experience_ref'];
    if (history.id === practiceId) invalid(path, 'A practice cannot provide its own usage feedback');
    if (seen.has(history.id)) invalid(path, 'Declare each experience once per assignment');
    if (history.version !== observed.version) invalid(path, 'Experience changed; read it again before adopting', true);
    seen.add(history.id);
    resolved.push({ ...use, ...observed, index });
  }
  // Preserve previously declared guidance for subsequent topic review/production,
  // while the dispatched brief itself carries only this decision's selected uses.
  const prior = await env.DB.prepare('select experience_id,reason from learning_uses where practice_id=? and task_id=? order by experience_id')
    .bind(practiceId, task.id).all<{ experience_id: string; reason: string }>();
  const guidance = new Map(prior.results.map(use => [use.experience_id, use.reason]));
  for (const use of resolved) guidance.set(use.id, use.reason);
  const at = now();
  try {
    await commitRecords(env.DB, scope, receipt, input, [{ previous, data }], [
      ...resolved.map(use => env.DB.prepare(`insert into learning_uses(practice_id,experience_id,task_id,agent_id,observed_version,reason,compatibility,created_at)
        values(?,?,?,?,?,?,?,?) on conflict(practice_id,experience_id,task_id)
        do update set observed_version=excluded.observed_version,reason=excluded.reason,compatibility=excluded.compatibility`)
        .bind(practiceId, use.id, task.id, task.agent_id, use.version, use.reason, use.compatibility, at)),
      env.DB.prepare('insert into learning_delegations(operation_id,leader_task_id,record_id,child_run_id,guidance_json,created_at) values(?,?,?,?,?,?)')
        .bind(operation.id, task.id, practiceId, `child-${task.id}-${operation.turn}`,
          JSON.stringify([...guidance.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, reason]) => reason)), at),
    ]);
  } catch (error) {
    // Existing SQL adoption guards check observed versions inside the transaction.
    // Report a raced observation only after checking the commit receipt.
    if (!await replayOperation(env.DB, scope, receipt, input)) {
      for (const use of resolved) {
        const current = await getRecord(env.DB, scope, use.id);
        if (!current || current.version !== use.version) invalid(['experience_uses', use.index, 'experience_ref'], 'Experience changed before adoption committed; read it again', true);
      }
      throw error;
    }
  }
  return bindLearningDelegation(env, task, operation, practiceId);
}

export function delegatedExperienceContext(context: string, uses: ExperienceUse[]) {
  if (!uses.length) return context;
  return `${context}\n\nGuidance applied to this assignment:\n${uses.map(use => `- ${use.reason}\n  Applicability and uncertainty: ${use.compatibility}`).join('\n')}`;
}
