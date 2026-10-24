import { z } from 'zod';
import type { D1Database } from '@cloudflare/workers-types';
import type { TaskSubject } from '../agent-runtime/task-subjects';
import { ToolContractError } from '../agent-runtime/tool-failure';

export const findingSchema = z.object({
  scope: z.enum(['object', 'practice', 'unknown']),
  subjects: z.array(z.object({ type: z.string().min(1), id: z.string().min(1), version: z.string().min(1).nullable() })),
  kind: z.enum(['adjustment', 'delivery', 'conclusion', 'limitation']),
  text: z.string().min(1),
  evidence_refs: z.array(z.string().min(1)).min(1),
});
export type LearningFinding = z.infer<typeof findingSchema>;
export type EvidenceAttribution = {
  task_id?: string; parent_task_id?: string; assignment_id?: string; parent_assignment_id?: string;
  subjects: TaskSubject[];
};
/** Membership is mechanical; whether these facts support the statement remains Agent judgment. */
export async function validateFindings(db: D1Database, recordId: string, findings: LearningFinding[]) {
  const cache = new Map<string, EvidenceAttribution>();
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  for (const [index, finding] of findings.entries()) {
    const path = ['findings', index];
    if ((finding.scope === 'object') !== (finding.subjects.length > 0)) {
      issues.push({ path: [...path, 'subjects'], message: 'Object findings require subjects; practice and unknown findings have none' });
    }
    const supported = new Set<number>();
    for (const [i, ref] of finding.evidence_refs.entries()) {
      let attribution = cache.get(ref);
      if (!attribution) {
        const row = await db.prepare('select attribution_json from learning_evidence where id=? and record_id=?').bind(ref, recordId).first<{ attribution_json: string }>();
        if (!row) {
          issues.push({ path: [...path, 'evidence_refs', i], message: `Evidence is outside this practice: ${ref}` });
          continue;
        }
        attribution = JSON.parse(row.attribution_json) as EvidenceAttribution;
        cache.set(ref, attribution);
      }
      if (finding.scope === 'object') {
        const matches = finding.subjects.map((subject, n) => ({ n, match: attribution!.subjects.some(s =>
          s.type === subject.type && s.id === subject.id && (subject.version === null || s.version === subject.version)) })).filter(s => s.match);
        if (!matches.length) issues.push({ path: [...path, 'evidence_refs', i], message: `Evidence ${ref} does not belong to any cited object/version` });
        matches.forEach(s => supported.add(s.n));
      }
      if (finding.scope === 'unknown' && attribution.subjects.length)
        issues.push({ path: [...path, 'evidence_refs', i], message: `Evidence ${ref} has known object attribution` });
    }
    finding.subjects.forEach((_, i) => {
      if (!supported.has(i)) issues.push({ path: [...path, 'subjects', i], message: 'No cited evidence supports this object/version' });
    });
  }
  if (issues.length) throw new ToolContractError('Learning evidence attribution mismatch', {
    kind: 'invalid_request', effects: 'none', issues,
    guidance: 'Read the exact evidence attribution. Keep distinct objects and versions separate; use practice scope for aggregate judgments and unknown scope for unassigned evidence. Valid evidence remains saved.',
  });
}
export function findingText(findings: LearningFinding[], kind: LearningFinding['kind']): string[] {
  return findings.filter(f => f.kind === kind).map(f => {
    const scope = f.scope === 'object' ? f.subjects.map(s => `${s.type}:${s.id}${s.version ? `@${s.version}` : ''}`).join(', ') : f.scope;
    return `[${scope}] ${f.text}`;
  });
}
