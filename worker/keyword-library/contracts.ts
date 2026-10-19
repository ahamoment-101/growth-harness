import { z } from 'zod';

const text = z.string().trim();
export const referenceSchema = text.min(1);
export const scopeSchema = z.object({
  workspace_id: referenceSchema,
  site_id: referenceSchema,
  locale: text.min(1).transform((value, ctx) => {
    try { return new Intl.Locale(value).toString(); } catch {
      ctx.addIssue({ code: 'custom', message: 'A valid BCP 47 locale is required' });
      return z.NEVER;
    }
  }),
}).strict();
export const actorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('human'), id: referenceSchema }).strict(),
  z.object({ type: z.literal('agent'), id: referenceSchema, run_id: referenceSchema, task_id: referenceSchema }).strict(),
]);
export const detailQuerySchema = z.object({
  membership_after: z.object({ parent_id: referenceSchema, child_id: referenceSchema }).strict().optional(),
  topic_after: referenceSchema.optional(),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();
export const evidenceSchema = z.object({
  source: text.min(1), url: z.string().url().optional(),
  observed_at: z.iso.datetime(), observation: text.min(1),
}).strict();
export const metricSchema = z.object({
  name: text.min(1), value: z.number().finite().nullable(), unit: text,
  source: text.min(1), observed_at: z.iso.datetime(),
  period: text.min(1), scope: text.min(1),
}).strict();
export const keywordDataSchema = z.object({
  intents: z.array(text.min(1)).default([]), stages: z.array(text.min(1)).default([]),
  audiences: z.array(text.min(1)).default([]), scenarios: z.array(text.min(1)).default([]),
  business_relevance: text.nullable().default(null),
  priority: text.nullable().default(null), priority_reason: text.nullable().default(null),
  suggested_formats: z.array(text.min(1)).default([]),
  uncertainties: z.array(text.min(1)).default([]),
  evidence: z.array(evidenceSchema).default([]), metrics: z.array(metricSchema).default([]),
}).strict();
export const groupDataSchema = z.object({ description: text.nullable().default(null) }).strict();
export const clusterDataSchema = z.object({
  need: text.nullable().default(null), rationale: text.nullable().default(null),
  evidence: z.array(evidenceSchema).default([]),
}).strict();
export const kindSchema = z.enum(['keyword', 'topic_group', 'cluster']);
export type Kind = z.infer<typeof kindSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type Actor = z.infer<typeof actorSchema>;
export const dataSchemas = { keyword: keywordDataSchema, topic_group: groupDataSchema, cluster: clusterDataSchema };
export const listSchema = z.object({
  kind: kindSchema.optional(), query: text.optional(), parent_id: referenceSchema.optional(),
  intent: text.optional(), archived: z.boolean().default(false),
  after: referenceSchema.optional(), limit: z.number().int().min(1).max(100).default(30),
}).strict();
export const logQuerySchema = z.object({
  target_id: referenceSchema.optional(), actor_type: z.enum(['human', 'agent']).optional(),
  before: z.object({ created_at: z.iso.datetime(), id: referenceSchema }).strict().optional(),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();
