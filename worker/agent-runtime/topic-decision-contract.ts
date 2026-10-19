import { z } from 'zod';

const evidenceSchema = z.object({
  source_type: z.enum(['library', 'strategy', 'business', 'history', 'performance', 'web']).describe(
    'Where this evidence came from. Use "web" only for a result returned by topic_search_web in this Run; use strategy/business/history/performance for anything read from the provided context.',
  ),
  ref: z.string().trim().min(1).max(800).describe(
    'Identifier of the exact source. For source_type "web" this MUST be the verbatim url string of a topic_search_web result — not a title, a domain, or a prose citation. For internal sources use the context source id or the strategy_keyword_id, for example "active_strategy" or "sk_123".',
  ),
  summary: z.string().trim().min(1).max(1000).describe('What this source shows, in one or two sentences.'),
});

export const topicDecisionItemSchema = z.object({
  library_keyword_id: z.string().optional(),
  strategy_keyword_id: z.string().trim().min(1).max(200),
  keyword_id: z.string().trim().min(1).max(200),
  topic_key: z.string().trim().min(1).max(160),
  title_direction: z.string().trim().min(1).max(300),
  primary_keyword: z.string().trim().min(1).max(300),
  content_type: z.enum(['COMPARISON', 'METHOD', 'GUIDE', 'LANDING', 'LIST', 'CASE_STUDY']),
  locale: z.string().trim().min(1).max(20),
  search_intent: z.string().trim().min(1).max(500),
  group_role: z.string().trim().min(1).max(500),
  rationale: z.string().trim().min(1).max(1200),
  hypothesis: z.string().trim().min(1).max(1200),
  evidence: z.array(evidenceSchema).min(1).max(12),
  relationship_to_existing: z.string().trim().max(1000),
  risk: z.string().trim().max(800),
});

const topicGroupSchema = z.object({
  goal: z.string().trim().min(1).max(1500),
  hypothesis: z.string().trim().min(1).max(1500),
  expected_signals: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  risks: z.array(z.string().trim().min(1).max(500)).max(10),
  unknowns: z.array(z.string().trim().min(1).max(500)).max(10),
  previous_group_relationship: z.string().trim().max(1200),
  items: z.array(topicDecisionItemSchema).min(1).max(20),
});

const researchRequestSchema = z.object({
  gap: z.string().trim().min(1).max(1500),
  why_blocking: z.string().trim().min(1).max(1500),
  known: z.array(z.string().trim().min(1).max(500)).max(12),
  unknown: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  requested_evidence: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  reconsider_after: z.string().trim().min(1).max(1200),
});

const deferSchema = z.object({
  reason: z.string().trim().min(1).max(1500),
  blockers: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  recommended_action: z.string().trim().min(1).max(1200),
  resume_when: z.string().trim().min(1).max(1200),
});

export const topicDecisionOutputSchema = z.object({
  decision_type: z.enum(['topic_group', 'needs_research', 'defer']),
  rationale: z.string().trim().min(1).max(2000),
  group: topicGroupSchema.nullable(),
  research_request: researchRequestSchema.nullable(),
  defer: deferSchema.nullable(),
}).superRefine((value, ctx) => {
  if (value.decision_type === 'topic_group' && !value.group) {
    ctx.addIssue({ code: 'custom', message: 'topic_group decision requires group' });
  }
  if (value.decision_type === 'topic_group' && (value.research_request || value.defer)) {
    ctx.addIssue({ code: 'custom', message: 'topic_group decision cannot include research_request or defer' });
  }
  if (value.decision_type === 'needs_research' && !value.research_request) {
    ctx.addIssue({ code: 'custom', message: 'needs_research decision requires research_request' });
  }
  if (value.decision_type === 'needs_research' && value.group) {
    ctx.addIssue({ code: 'custom', message: 'needs_research decision cannot include group' });
  }
  if (value.decision_type === 'needs_research' && value.defer) {
    ctx.addIssue({ code: 'custom', message: 'needs_research decision cannot include defer' });
  }
  if (value.decision_type === 'defer' && !value.defer) {
    ctx.addIssue({ code: 'custom', message: 'defer decision requires defer details' });
  }
  if (value.decision_type === 'defer' && (value.group || value.research_request)) {
    ctx.addIssue({ code: 'custom', message: 'defer decision cannot include group or research_request' });
  }
});

export type TopicDecisionOutput = z.infer<typeof topicDecisionOutputSchema>;
export type TopicDecisionItemOutput = z.infer<typeof topicDecisionItemSchema>;

export function aggregateLanguageTopicDecisions(
  decisions: Array<{ locale: string; output: TopicDecisionOutput }>,
): TopicDecisionOutput {
  const groups = decisions.filter((item) => item.output.decision_type === 'topic_group' && item.output.group);
  if (groups.length) {
    // Locales that did not produce a group keep their own outcome in
    // `languageDecisions`, but the aggregate returns a topic_group, so name them
    // here: otherwise a locale that deferred or ran out of budget is invisible
    // wherever only the aggregate is read.
    const withoutGroup = decisions.filter((item) => item.output.decision_type !== 'topic_group' || !item.output.group);
    return {
      decision_type: 'topic_group',
      rationale: [
        ...groups.map((item) => `[${item.locale}] ${item.output.rationale}`),
        ...withoutGroup.map((item) => `[${item.locale}] no group this Run (${item.output.decision_type}): ${item.output.rationale}`),
      ].join('\n'),
      group: {
        goal: groups.map((item) => `[${item.locale}] ${item.output.group!.goal}`).join('\n'),
        hypothesis: groups.map((item) => `[${item.locale}] ${item.output.group!.hypothesis}`).join('\n'),
        expected_signals: groups.flatMap((item) => item.output.group!.expected_signals).slice(0, 10),
        risks: groups.flatMap((item) => item.output.group!.risks).slice(0, 10),
        unknowns: groups.flatMap((item) => item.output.group!.unknowns).slice(0, 10),
        previous_group_relationship: groups.map((item) => `[${item.locale}] ${item.output.group!.previous_group_relationship}`).join('\n'),
        items: groups.flatMap((item) => item.output.group!.items),
      },
      research_request: null,
      defer: null,
    };
  }
  return decisions.find((item) => item.output.decision_type === 'needs_research')?.output
    || decisions.find((item) => item.output.decision_type === 'defer')?.output
    || (() => { throw new Error('Topic decision produced no language outcome'); })();
}

export function normalizeTopicDecisionBranches(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.decision_type === 'topic_group') return { ...record, research_request: null, defer: null };
  if (record.decision_type === 'needs_research') return { ...record, group: null, defer: null };
  if (record.decision_type === 'defer') return { ...record, group: null, research_request: null };
  return value;
}

export const TOPIC_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision_type: { type: 'string', enum: ['topic_group', 'needs_research', 'defer'] },
    rationale: { type: 'string' },
    group: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false,
          properties: {
            goal: { type: 'string' }, hypothesis: { type: 'string' },
            expected_signals: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
            risks: { type: 'array', items: { type: 'string' } },
            unknowns: { type: 'array', items: { type: 'string' } },
            previous_group_relationship: { type: 'string' },
            items: {
              type: 'array', minItems: 1, maxItems: 20,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  strategy_keyword_id: { type: 'string' }, keyword_id: { type: 'string' },
                  topic_key: { type: 'string' }, title_direction: { type: 'string' }, primary_keyword: { type: 'string' },
                  content_type: { type: 'string', enum: ['COMPARISON', 'METHOD', 'GUIDE', 'LANDING', 'LIST', 'CASE_STUDY'] },
                  locale: { type: 'string' }, search_intent: { type: 'string' },
                  group_role: { type: 'string' }, rationale: { type: 'string' }, hypothesis: { type: 'string' },
                  evidence: {
                    type: 'array', minItems: 1, maxItems: 12, items: {
                      type: 'object', additionalProperties: false,
                      properties: {
                        source_type: {
                          type: 'string', enum: ['library', 'strategy', 'business', 'history', 'performance', 'web'],
                          description: 'Use "web" only for a result returned by topic_search_web in this Run.',
                        },
                        ref: {
                          type: 'string',
                          description: 'For source_type "web", the verbatim url of a topic_search_web result — never a title, domain, or prose citation. Otherwise the context source id or strategy_keyword_id.',
                        },
                        summary: { type: 'string' },
                      },
                      required: ['source_type', 'ref', 'summary'],
                    },
                  },
                  relationship_to_existing: { type: 'string' }, risk: { type: 'string' },
                },
                required: ['strategy_keyword_id', 'keyword_id', 'topic_key', 'title_direction', 'primary_keyword', 'content_type', 'locale', 'search_intent', 'group_role', 'rationale', 'hypothesis', 'evidence', 'relationship_to_existing', 'risk'],
              },
            },
          },
          required: ['goal', 'hypothesis', 'expected_signals', 'risks', 'unknowns', 'previous_group_relationship', 'items'],
        },
      ],
    },
    research_request: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false,
          properties: {
            gap: { type: 'string' }, why_blocking: { type: 'string' },
            known: { type: 'array', items: { type: 'string' } },
            unknown: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
            requested_evidence: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
            reconsider_after: { type: 'string' },
          },
          required: ['gap', 'why_blocking', 'known', 'unknown', 'requested_evidence', 'reconsider_after'],
        },
      ],
    },
    defer: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false,
          properties: {
            reason: { type: 'string' },
            blockers: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
            recommended_action: { type: 'string' },
            resume_when: { type: 'string' },
          },
          required: ['reason', 'blockers', 'recommended_action', 'resume_when'],
        },
      ],
    },
  },
  required: ['decision_type', 'rationale', 'group', 'research_request', 'defer'],
};

export const topicSearchDecisionSchema = z.object({
  action: z.enum(['search_web', 'finalize']),
  judgment_summary: z.string().trim().min(1).max(1000),
  queries: z.array(z.string().trim().min(1).max(300)).max(3),
}).superRefine((value, ctx) => {
  if (value.action === 'search_web' && value.queries.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'search_web requires at least one query' });
  }
  if (value.action === 'finalize' && value.queries.length !== 0) {
    ctx.addIssue({ code: 'custom', message: 'finalize cannot include queries' });
  }
});

export const TOPIC_SEARCH_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['search_web', 'finalize'] },
    judgment_summary: { type: 'string' },
    queries: { type: 'array', maxItems: 3, items: { type: 'string' } },
  },
  required: ['action', 'judgment_summary', 'queries'],
};

