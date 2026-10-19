import { z } from 'zod';
import type { RuntimeAgentEnv } from './env';
import { ToolRegistry } from './tools';
import { contentSourceTool, editorialReviewFields } from './content-editorial';

const judgmentSchema = z.string().trim().min(1).max(1200);

// Flattened object instead of a discriminated union: the tested gateway tool-call decoding
// cannot generate arguments for a root-level oneOf schema and emits `{}`.
// Cross-branch rules live in superRefine so errors stay field-precise.
export const submitContentReviewInputSchema = z.object({
  decision: z.enum(['pass', 'revise']),
  value_assessment: z.string().trim().min(1).max(3000),
  seo_geo_risks: z.array(z.string().trim().min(1).max(1200)).max(16),
  required_changes: z.array(z.string().trim().min(1).max(1200)).max(16),
  judgment_summary: judgmentSchema,
}).superRefine((value, ctx) => {
  if (value.decision === 'revise' && value.required_changes.length < 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['required_changes'],
      message: "decision='revise' requires at least one actionable item in required_changes",
    });
  }
});

export const submitEditorialReviewInputSchema = submitContentReviewInputSchema.safeExtend(editorialReviewFields);

/** Definition v10: the review states its strategy, topic, self-check and link judgments explicitly. */
export const submitStrategyReviewInputSchema = submitEditorialReviewInputSchema.safeExtend({
  seo_strategy_assessment: z.string().trim().min(1).max(4000).describe('Whether the page satisfies its SEO strategy: intent, market, role, page type, overlap, citable answers, links and product connection'),
  topic_requirement_assessment: z.string().trim().min(1).max(4000).describe('Whether the article delivers what the topic decision and coverage requirements promised'),
  author_self_check_assessment: z.string().trim().min(1).max(3000).describe("Whether the author's declined findings and fixes from the fresh self-check hold in the text"),
  link_assessment: z.string().trim().min(1).max(3000).describe('Overall judgment of internal link count, placement and targets'),
  link_findings: z.array(z.object({
    locale: z.string().trim().min(1).max(40), anchor_text: z.string().trim().max(300), target: z.string().trim().max(500),
    problem: z.string().trim().min(1).max(1500), recommended_change: z.string().trim().min(1).max(1500),
  })).max(20).default([]).describe('Only links with a problem, plus a missing link where the reader clearly needs one'),
});

export const REVIEW_STRATEGY_FOCUS_INSTRUCTIONS = `Your review judges the article's content and its internal links. For content, answer two primary questions.
1. SEO strategy fit: does the page serve the assigned primary search intent and target market, fulfil its role in the group and demand direction, use the page type the strategy supports, answer the search task directly in the title and opening, avoid overlapping or competing with sibling and published pages, offer clear verifiable information that AI answers can cite, and follow the strategy's linking plan and conversion goal in its internal links and product connection?
2. Topic requirement fit: does the article deliver what the topic decision promised in title_direction, search_intent, group_role, rationale and hypothesis, and does it satisfy each assigned coverage requirement?
Record these judgments in seo_strategy_assessment and topic_requirement_assessment.
Verify rather than repeat the author's fresh self-check in seo_contract.self_check when present: check that declined findings were reasonably declined and that fixes hold in the text, in author_self_check_assessment. Machine-sounding writing is the author's focus; raise it only when it materially harms the reader.
Internal link review is your responsibility. The author placed the links; internal_links lists each one with its locale, anchor, sentence and resolved target. Check:
- Count: each locale contains between 1 and 3 internal links, including the product page.
- Placement: the link appears where the reader genuinely needs further reading or a next step, and the anchor is natural and accurately describes the target.
- Target: the linked page genuinely serves that reader need, matches the locale and does not compete with this article for the same search need. A target of kind unavailable is a defect.
- Siblings: an unpublished sibling must not be described as a live page.
Write the overall judgment in link_assessment. List only problem links, and any place where the reader clearly needs a missing link, in link_findings with a concrete change. Choose revise when a link problem needs the author to change the article.
Evidence support for factual claims and product capability boundaries remain baseline checks.
On a later assignment for the same article, your earlier review remains in this conversation: focus on whether the previous required changes are resolved and on the parts that changed.`;

export const deferContentReviewInputSchema = z.object({
  reason: z.string().trim().min(1).max(1800),
  resume_when: z.string().trim().min(1).max(1200),
  judgment_summary: judgmentSchema,
});

const reviewActionResultSchema = z.object({}).passthrough();

export function createContentReviewToolRegistry(env: RuntimeAgentEnv, editorial = true, strategyFocus = false): ToolRegistry {
  const registry = new ToolRegistry();
  if (editorial) registry.register(contentSourceTool(env));
  return registry
    .register({
      name: 'submit_content_review', replaySafety: 'unreconciled', version: strategyFocus ? 3 : editorial ? 2 : 1,
      preserveOutputSize: true,
      description: [
        'Submit the parent editor decision for the exact candidate artifact locked to this review Run.',
        'Validated on submit: decision accepts only the literals pass or revise; the artifact must still be the candidate this Run was locked to, and must not have been superseded by a newer attempt while you were reading it.',
        'pass sends the article straight to human publication review. revise returns it to the article sub-Agent with required_changes, which must be actionable.',
        'When you cannot decide safely, call defer_content_review instead.',
      ].join('\n'),
      capability: 'write', inputSchema: strategyFocus ? submitStrategyReviewInputSchema : editorial ? submitEditorialReviewInputSchema : submitContentReviewInputSchema, outputSchema: reviewActionResultSchema,
      timeoutMs: 30_000, retryable: false, approval: 'never', executionMode: 'durable_async',
    })
    .register({
      name: 'defer_content_review', replaySafety: 'unreconciled', version: 1,
      preserveOutputSize: true,
      description: 'Preserve the candidate and stop this isolated review when a responsible pass or revise decision cannot be made.',
      capability: 'write', inputSchema: deferContentReviewInputSchema, outputSchema: reviewActionResultSchema,
      timeoutMs: 30_000, retryable: false, approval: 'never', executionMode: 'durable_async',
    });
}
