import { ARTICLE_MARKDOWN_CAPABILITIES } from '../../shared/article-presentation';
import { z } from 'zod';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { contentSourceTool, evidenceLedgerTool, coverageResponseSchema } from './content-editorial';
import type { RuntimeAgentEnv } from './env';
import { registerPublishedArticleTools } from './published-article-tools';
import { ToolRegistry } from './tools';
import { searchTaskWeb } from './task-usage';
import { findLinkTargetsTool } from './content-author-links';
import { deliverArticleDescription, deliverArticleInput, runSelfCheckDescription, runSelfCheckInput, saveArticleDraftDescription } from './content-self-check';

const judgmentSchema = z.string().trim().min(1).max(1000);

export const articleVersionSchema = z.object({
  meta_description: z.string().trim().max(2000).optional().describe('A concise, accurate search and social preview description, separate from the visible summary.'),
  image_url: z.string().trim().optional().describe('Optional verified public HTTP(S) article image URL from available evidence; omit when unavailable. Never invent a URL.'),
  image_alt: z.string().trim().optional().describe('Description of the actual image for readers who cannot see it.'),
  locale: z.string().trim().min(1).max(40),
  slug: z.string().trim().min(1).max(240),
  title: z.string().trim().min(1).max(500),
  excerpt: z.string().trim().min(1).max(2000),
  content: z.string().trim().min(1).max(160_000),
});

export const articleBundleSchema = z.object({
  versions: z.array(articleVersionSchema).min(1).max(20),
  seo_contract: z.object({
    search_intent: z.string().trim().min(1).max(500),
    reader_value: z.string().trim().min(1).max(4000),
    direct_answer: z.string().trim().min(1).max(6000),
    primary_keyword: z.string().trim().min(1).max(500),
    supporting_terms: z.array(z.string().trim().min(1).max(500)).max(100),
    factual_claims: z.array(z.object({
      claim: z.string().trim().min(1).max(4000),
      evidence_ref: z.string().trim().min(1).max(2000),
    })).max(100),
    geo_summary: z.string().trim().min(1).max(6000),
  }),
});

export type ArticleBundle = z.infer<typeof articleBundleSchema>;

export const submitArticleInputSchema = z.object({
  bundle: articleBundleSchema,
  judgment_summary: judgmentSchema,
});

export const submitEditorialArticleInputSchema = z.object({
  bundle: articleBundleSchema.extend({
    seo_contract: articleBundleSchema.shape.seo_contract.omit({ factual_claims: true }),
    ledger_ref: z.string().min(1), coverage_response: coverageResponseSchema,
  }),
  judgment_summary: judgmentSchema,
});

/** Accept the same explicit judgment when an existing model places it inside
 * bundle. The advertised JSON Schema stays pinned; no judgment is invented. */
export const saveArticleDraftInputSchema = z.preprocess(input => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  if (Object.hasOwn(value, 'judgment_summary')) return input;
  const bundle = value.bundle;
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return input;
  const nested = (bundle as Record<string, unknown>).judgment_summary;
  return typeof nested === 'string' ? { ...value, judgment_summary: nested } : input;
}, submitEditorialArticleInputSchema);

/** Existing model calls sometimes place an explicit judgment inside bundle.
 * Lift it before Pi's JSON Schema validation; the raw provider receipt remains
 * stored separately and the authoritative domain schema still validates it. */
export function adaptArticleDraftModelResponse(response: AssistantMessage): AssistantMessage {
  return { ...response, content: response.content.map(part => {
    if (part.type !== 'toolCall' || part.name !== 'save_article_draft') return part;
    const input = part.arguments;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'judgment_summary')) return part;
    const bundle = (input as Record<string, unknown>).bundle;
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return part;
    const judgment = (bundle as Record<string, unknown>).judgment_summary;
    return typeof judgment === 'string' ? { ...part, arguments: { ...input, judgment_summary: judgment } } : part;
  }) };
}

export const deferArticleInputSchema = z.object({
  reason: z.string().trim().min(1).max(1500),
  resume_when: z.string().trim().min(1).max(1200),
  judgment_summary: judgmentSchema,
});

const articleActionResultSchema = z.object({}).passthrough();

/** selfCheck (definition v17): drafts are checked in a fresh session before delivery; submit_article stays for pinned earlier tasks. */
/** 'all' is for contract inspection only: it registers every version's tools so the definition can be checked. */
export function createArticleProductionToolRegistry(env: RuntimeAgentEnv, editorial = true, selfCheck: boolean | 'all' = false): ToolRegistry {
  const registry = new ToolRegistry();
  if (editorial) registry.register(contentSourceTool(env)).register(evidenceLedgerTool(env));
  if (selfCheck) registry
    .register(findLinkTargetsTool(env))
    .register({ name: 'save_article_draft', replaySafety: 'unreconciled', version: 1, preserveOutputSize: true, description: [saveArticleDraftDescription, ARTICLE_MARKDOWN_CAPABILITIES].join('\n'),
      capability: 'write', inputSchema: saveArticleDraftInputSchema, outputSchema: articleActionResultSchema,
      timeoutMs: 300_000, retryable: false, approval: 'never', executionMode: 'durable_call' })
    .register({ name: 'run_self_check', replaySafety: 'unreconciled', version: 1, preserveOutputSize: true, description: runSelfCheckDescription,
      capability: 'write', inputSchema: runSelfCheckInput, outputSchema: articleActionResultSchema,
      timeoutMs: 300_000, retryable: false, approval: 'never', executionMode: 'durable_call' })
    .register({ name: 'deliver_article', replaySafety: 'unreconciled', version: 1, preserveOutputSize: true, description: deliverArticleDescription,
      capability: 'write', inputSchema: deliverArticleInput, outputSchema: articleActionResultSchema,
      timeoutMs: 30_000, retryable: false, approval: 'never', executionMode: 'durable_async' });
  registry.register({
      name: 'article_search_web', version: 1,
      description: 'Search public web sources to investigate the assigned topic or verify facts. Results contain URLs, titles and search snippets, not full pages; cite only what the returned evidence supports and distinguish uncertainty. Select country for the target market when useful.',
      inputSchema: z.object({
        queries: z.array(z.string().trim().min(1).max(500)).min(1).max(6),
        country: z.string().regex(/^[A-Z]{2}$/).optional(),
        judgment_summary: judgmentSchema,
      }),
      outputSchema: z.array(z.object({ url: z.string(), title: z.string(), content: z.string() }).passthrough()),
      capability: 'external', timeoutMs: 150_000, retryable: false, replaySafety: 'repeatable', approval: 'never', preserveOutputSize: true,
      execute: (args, context) => searchTaskWeb(env, context.runId, args.queries, context.signal, args.country),
    });
  if (selfCheck !== true) registry.register<unknown, Record<string, unknown>>({
      name: 'submit_article', replaySafety: 'unreconciled', version: editorial ? 2 : 1,
      preserveOutputSize: true,
      description: [
        'Submit a complete article bundle for objective contract validation and durable persistence.',
        'Validated on submit — bundle identity: exactly one version per required locale, no duplicates, no extras; seo_contract.reader_value and seo_contract.direct_answer both non-empty.',
        'Validated on submit — deterministic QA: every locale needs slug, title and content; slugs must be lowercase kebab-case and distinct across locales; content must use supported Markdown with closed code fences and public HTTP(S) image URLs.',
        'Choose links and anchor text for reader value; the reviewer assesses their relevance. A hub link is not required by the submission protocol.',
        ARTICLE_MARKDOWN_CAPABILITIES,
      ].join('\n'),
      capability: 'write', inputSchema: editorial ? submitEditorialArticleInputSchema : submitArticleInputSchema, outputSchema: articleActionResultSchema,
      timeoutMs: 30_000, retryable: false, approval: 'never', executionMode: 'durable_async',
    });
  registry.register({
      name: 'defer_article', replaySafety: 'unreconciled', version: 1,
      preserveOutputSize: true,
      description: 'Stop safely without fabricating an article when the task cannot responsibly be completed in this Run. The job is preserved with your reason and can be retried; nothing is published and no artifact is created.',
      capability: 'write', inputSchema: deferArticleInputSchema, outputSchema: articleActionResultSchema,
      timeoutMs: 30_000, retryable: false, approval: 'never', executionMode: 'durable_async',
    });
  return registerPublishedArticleTools(registry, env);
}
