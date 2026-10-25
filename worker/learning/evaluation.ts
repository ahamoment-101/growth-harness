import { z } from 'zod';
import type { LearningData } from '../../shared/learning';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import type { AgentTask, TaskOperation } from '../agent-runtime/task-store';
import type { ToolRegistry } from '../agent-runtime/tools';
import { bindOperation, resolveSlot, saveSlot } from '../agent-runtime/parameter-slots';
import { ToolContractError } from '../agent-runtime/tool-failure';
import { readRuntimeJson } from '../agent-runtime/runtime-content';
import type { EvidenceAttribution } from './attribution';
import { addEvidence, recordDetail, requireRecord } from './store';

export const EVALUATION_TOOLS = ['read_business_evaluation', 'submit_business_outcome'] as const;
export const EVALUATION_INSTRUCTIONS = `\nAfter preparation, read_business_evaluation exposes the frozen agreement and evidence collection plan. Decide how to obtain its required evidence within the authorized business scope. Put relevant acceptance criteria and evidence requirements into ordinary specialist assignments; specialists do not learn the learning protocol or score experience utility. If the agreement requires an independent review, arrange or perform a review independent of the author where the agreement permits it; a topic author's self-assessment is not that review. A Learning Agent can assess a formal deliverable against a qualitative rubric when that is the agreed evaluator. Do not invent an external reviewer or measurement source.\nAfter formal delivery, read the saved evaluation and evidence, then submit_business_outcome with exact evidence_refs, the available observations and limitations. This requests evaluation; it does not certify success or set utility. Report unavailable inputs honestly, or arrange authorized evidence collection; do not silently treat delivery as evaluation or rewrite the frozen standard. Pending external windows can remain pending while business work finishes. GSC collection remains automatic. Record consequential coordination decisions separately. A corrected outcome replaces this practice's contribution, not an extra sample.`;

function invalid(message: string, path: Array<string | number>): never {
  throw new ToolContractError(message, { kind: 'invalid_request', effects: 'none', issues: [{ path, message }],
    guidance: 'Read the saved evaluation and scoped formal evidence. Preserve missing evidence; never invent a score or change the agreement.' });
}
const scopeOf = (task: AgentTask) => ({ workspaceId: task.workspace_id, siteId: task.site_id });
async function ownPractice(env: RuntimeAgentEnv, task: AgentTask, id: string) {
  const row = await requireRecord(env.DB, scopeOf(task), id);
  if (row.origin_task_id !== task.id || task.agent_id !== 'growth_leader') invalid('Practice belongs to another coordinator', ['practice_ref']);
  return row;
}

/** Resolve exact, immutable source receipts, never titles or a current object version. */
export async function citedEvidence(env: Pick<RuntimeAgentEnv, 'DB'>, recordId: string, refs: string[]) {
  if (new Set(refs).size !== refs.length) invalid('Duplicate evidence reference', ['evidence_refs']);
  const evidence = [];
  const subjects = new Map<string, EvidenceAttribution['subjects'][number]>();
  for (const [i, id] of refs.entries()) {
    const row = await env.DB.prepare('select id,kind,source_ref,payload_json,attribution_json from learning_evidence where id=? and record_id=?')
      .bind(id, recordId).first<{ id: string; kind: string; source_ref: string; payload_json: string; attribution_json: string }>();
    if (!row) invalid('Evidence is outside this practice', ['evidence_refs', i]);
    const attribution = JSON.parse(row.attribution_json) as EvidenceAttribution;
    for (const subject of attribution.subjects) subjects.set(JSON.stringify(subject), subject);
    evidence.push({ id: row.id, kind: row.kind, source_ref: row.source_ref, attribution,
      payload: await readRuntimeJson<unknown>(env.DB, row.payload_json) });
  }
  return { evidence, subjects: [...subjects.values()] };
}

export function addEvaluationTools(registry: ToolRegistry, env: RuntimeAgentEnv, task: AgentTask, operation?: TaskOperation) {
  if (task.definition_version < 25) return;
  const common = { version: 1, approval: 'never' as const, timeoutMs: 60_000, retryable: false, outputSchema: z.unknown() };
  registry.register({ ...common, name: 'read_business_evaluation', capability: 'read', preserveOutputSize: true,
    description: 'Read this practice’s frozen evaluation, collection responsibility, current assessment and paginated formal evidence. Returns evaluation_ref bound to this exact agreement, not a guessed version.',
    inputSchema: z.object({ practice_ref: z.string().min(1) }), execute: async args => {
      const row = await ownPractice(env, task, args.practice_ref);
      const data: LearningData = JSON.parse(row.data_json);
      const detail = await recordDetail(env.DB, scopeOf(task), row.id);
      return { practice_ref: row.id, agreement: data.experience.evaluation, observation: data.experience.observation,
        preparation: data.experience.preparation, assessment: data.experience.assessment,
        evaluation_ref: await saveSlot(env.DB, task, 'business_evaluation', { id: row.id, agreement: data.experience.evaluation }),
        evidence: detail.evidence, next_cursors: detail.next_cursors, processing: detail.processing,
        meaning: 'A delivery receipt is not an outcome assessment. Follow evidence pagination through read_business_experience_page when needed.' };
    } });
  registry.register({ ...common, name: 'submit_business_outcome', capability: 'write', replaySafety: 'idempotent',
    description: 'Submit observed results supported by exact formal evidence for Learning Agent evaluation against the frozen agreement. No reward or utility input. Numeric observations must come from the cited source; qualitative evidence is judged by the Learning Agent. Incomplete evidence remains unknown. Does not replace automatic GSC collection.',
    inputSchema: z.object({ evaluation_ref: z.string().min(1), evidence_refs: z.array(z.string().min(1)).min(1), summary: z.string().min(1),
      availability: z.enum(['complete', 'incomplete']), limitations: z.array(z.string()),
      values: z.array(z.object({ name: z.string().min(1), value: z.number().finite(), unit: z.string().min(1) })) }),
    execute: async args => {
      if (!operation) throw new Error('Outcome requires a durable operation');
      const bound = await bindOperation(env.DB, task, operation, args, async () => {
        const selected = await resolveSlot<{ id: string; agreement: LearningData['experience']['evaluation'] }>(env.DB, task, args.evaluation_ref, 'business_evaluation');
        const row = await ownPractice(env, task, selected.id), data: LearningData = JSON.parse(row.data_json);
        const agreement = data.experience.evaluation;
        if (!agreement || data.experience.preparation !== 'ready' || JSON.stringify(agreement) !== JSON.stringify(selected.agreement))
          invalid('A frozen, observed pre-action agreement is required', ['evaluation_ref']);
        if (data.experience.observation?.source === 'gsc') invalid('This agreement uses the automatic GSC observation window; submit no replacement manual measurement', ['evaluation_ref']);
        const cited = await citedEvidence(env, row.id, args.evidence_refs);
        if (cited.evidence.some(e => e.kind === 'outcome')) invalid('Cite original source evidence, not an earlier outcome assessment', ['evidence_refs']);
        const values: Record<string, { value: number; unit: string }> = {};
        for (const [i, v] of args.values.entries()) {
          const input = agreement.inputs.find(input => input.name === v.name);
          if (!input || input.unit !== v.unit || values[v.name]) invalid('Observation must use a unique agreed input and unit', ['values', i]);
          values[v.name] = { value: v.value, unit: v.unit };
        }
        return { recordId: row.id, payload: { source: 'formal_evidence', agreement_version: agreement.version,
          complete: args.availability === 'complete', summary: args.summary, limitations: args.limitations, values,
          evidence_refs: args.evidence_refs, evidence: cited.evidence },
          attribution: { task_id: task.id, subjects: cited.subjects } };
      });
      const id = `leader-outcome:${operation.id}`;
      await addEvidence(env.DB, scopeOf(task), bound.recordId, id, 'outcome', task.id, bound.payload, bound.attribution);
      return { recorded: true, practice_ref: bound.recordId, evidence_ref: id, evaluation_status: 'queued',
        meaning: 'Evidence submitted for assessment. This receipt is not a score or proof of success.' };
    } });
}
