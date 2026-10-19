import { z } from 'zod';
import { findingSchema, sourceIndex } from '../lib/research/evidence';
import type { RuntimeAgentEnv } from './env';
import type { AgentTask } from './task-store';
import { readRuntimeJson } from './runtime-content';

export const researchRequestSchema = z.object({
  research_question: z.string().trim().min(1).max(12000),
  decision_use: z.string().max(4000).default('').describe('Which decision or exploration deliverable this research will support'),
  scope: z.string().max(6000).default('').describe('Market, language, time, objects and exclusions; describe meaningful boundaries'),
  deliverable: z.string().max(4000).default('').describe('Expected comparison, verification, opportunity analysis or explanation'),
  context: z.string().max(20000).default('').describe('Existing findings, source pointers and remaining gaps; include only necessary context'),
});
export const researchBriefSchema = researchRequestSchema.extend({ locale: z.string().min(1).max(100) });
const notebookId = z.string().min(1).max(300);
const notebookFindingSchema = findingSchema.extend({ id: notebookId.optional() });
const questionSchema = z.object({
  id: notebookId.optional(),
  question: z.string().min(1).max(2000),
  status: z.enum(['open', 'answered', 'blocked', 'out_of_scope']),
  answer: z.string().max(6000),
  decision_impact: z.string().max(3000).describe('What answering this question could change; explain why a remaining gap matters or does not matter'),
});
const assessmentSchema = z.object({
  coverage: z.string().max(6000), evidence: z.string().max(6000),
  disagreements: z.string().max(6000), limitations: z.string().max(6000),
  decision_readiness: z.string().max(6000), stopping_reason: z.string().max(4000),
});
export const researchResultSchema = z.object({
  task_id: z.string(), outcome: z.enum(['completed', 'partial', 'needs_input', 'no_findings', 'paused', 'failed', 'cancelled']),
  summary: z.string(), report: z.string(), findings: z.array(notebookFindingSchema), unknowns: z.array(z.string()),
  sources: z.array(z.object({ id: z.string(), url: z.string(), title: z.string(), captured_at: z.string(), evidence_type: z.enum(['page_snapshot', 'provider_excerpt']).default('page_snapshot'), excerpt: z.string().default('') })),
  reason: z.string(),
  questions: z.array(questionSchema).default([]),
  completion_assessment: assessmentSchema.optional(),
});
export type ResearchResult = z.infer<typeof researchResultSchema>;

/** Read historical notebooks without retaining their former Agent execution code. */
export async function resultForTask(env: RuntimeAgentEnv, task: AgentTask): Promise<ResearchResult> {
  const saved = await readRuntimeJson<Record<string, any>>(env.DB, task.output_json);
  const notes = await readRuntimeJson<Record<string, any>>(env.DB, task.workspace_json);
  return researchResultSchema.parse({ task_id: task.id,
    outcome: saved.outcome || (task.status === 'completed' ? 'partial' : task.status === 'waiting' ? 'needs_input' : task.status === 'running' ? 'partial' : task.status),
    summary: saved.summary || '', report: saved.report || notes.report || '', findings: saved.findings || notes.findings || [],
    unknowns: saved.unknowns || notes.unknowns || [], questions: saved.questions || notes.questions || [],
    sources: saved.sources || await sourceIndex(env, task.id), reason: saved.reason || task.reason,
    completion_assessment: saved.completion_assessment });
}
