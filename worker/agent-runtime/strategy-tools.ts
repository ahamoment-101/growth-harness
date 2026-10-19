import { z } from 'zod';
import { fetchAutocomplete, fetchCompetitorSitemap } from '../lib/research/fetch';
import { latestGscQueries } from '../lib/research/store';
import { getStrategyRun } from '../lib/research/strategy-store';
import { researchRequestSchema, researchResultSchema } from './research-contract';
import { searchTaskWeb } from './task-usage';
import type { RuntimeAgentEnv } from './env';
import { loadStrategyResearchContext } from './strategy-context';
import { ToolRegistry } from './tools';

const domainSchema = z.string().trim().toLowerCase().max(253).refine(isPublicResearchDomain, 'A public hostname is required');
const judgmentSchema = z.string().trim().max(1000).default('');
const citationSchema = z.object({
  url: z.string().url(), title: z.string(), content: z.string(), query: z.string().optional(),
});
const pageSchema = z.object({ url: z.string().url(), title: z.string(), keyword_hint: z.string() });
const contextSourceSchema = z.object({
  sourceId: z.string(), version: z.string(), capturedAt: z.string(), priority: z.number(), value: z.unknown(),
});
async function safeSite(env: RuntimeAgentEnv, workspaceId: string, siteId: string) {
  const site = await env.DB.prepare(
    `select id, workspace_id, name, domain, root_domain, source_locale, hub_path,
            research_seed_terms_json, competitor_domains_json, product_brief, created_at
     from sites where workspace_id = ? and id = ?`,
  ).bind(workspaceId, siteId).first<Record<string, unknown>>();
  if (!site) throw new Error('Strategy research site not found');
  return site;
}

export function isPublicResearchDomain(value: string): boolean {
  if (!/^[a-z0-9.-]+$/i.test(value) || !value.includes('.') || value.startsWith('.') || value.endsWith('.')) return false;
  const lower = value.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) return false;
  if (/^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(lower)) return false;
  return true;
}

/** The task locale is host-owned. Strategy Runs record it on their business Run;
 * other research tasks supply the locale bound to their own task. */
export type ResearchLocaleResolver = (runId: string) => Promise<string>;

export function createStrategyResearchToolRegistry(env: RuntimeAgentEnv, localeFor?: ResearchLocaleResolver): ToolRegistry {
  const resolveLocale = localeFor || (async (runId: string) => (await getStrategyRun(env.DB, runId))?.source_locale || '');
  return new ToolRegistry()
    .register({
      name: 'read_strategy_research_context', version: 2, description: 'Read safe, versioned research context with immutable locale-market identity and evidence scope.',
      capability: 'read', inputSchema: z.object({ judgment_summary: judgmentSchema }), outputSchema: z.array(contextSourceSchema), timeoutMs: 15_000, retryable: true, approval: 'never',
      execute: async (_input, context) => {
        const run = await getStrategyRun(env.DB, context.runId);
        if (!run?.source_locale) throw new Error('Strategy Run lost its locale identity');
        return loadStrategyResearchContext(
          env.DB, await safeSite(env, context.workspaceId, context.siteId) as never, context.runId, run.source_locale,
        );
      },
    })
    .register({
      name: 'read_gsc_performance', version: 2,
      preserveOutputSize: true, description: 'Read latest site-wide GSC query performance. Locale attribution is unknown, so treat it only as cross-market evidence unless the query itself proves relevance.',
      capability: 'read', inputSchema: z.object({ judgment_summary: judgmentSchema }), outputSchema: z.object({ scope: z.literal('site_global'), locale_attribution: z.literal('unknown'), available: z.boolean(), rows: z.array(z.object({
        query: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number(), as_of: z.string(),
      })) }), timeoutMs: 10_000, retryable: true, approval: 'never',
      execute: async (_input, context) => { await safeSite(env, context.workspaceId, context.siteId); const rows = await latestGscQueries(env.DB, context.siteId); return { scope: 'site_global' as const, locale_attribution: 'unknown' as const, available: rows.length > 0, rows }; },
    })
    .register({
      name: 'fetch_competitor_sitemap', replaySafety: 'repeatable', version: 1,
      description: 'List the URLs a configured competitor publishes, from their public sitemap. Shows what topics a competitor covers and how they structure them; it says nothing about traffic, ranking, or quality. Only domains already configured for this site can be fetched, and the tool is unavailable when none are.',
      capability: 'external', inputSchema: z.object({ domain: domainSchema, judgment_summary: judgmentSchema }), outputSchema: z.object({
        domain: z.string(), sitemap_url: z.string().url(), pages: z.array(pageSchema), error: z.string(),
      }), timeoutMs: 45_000, retryable: true, approval: 'never',
      execute: async (input, context) => {
        const site = await safeSite(env, context.workspaceId, context.siteId);
        let configured: string[] = [];
        try { configured = JSON.parse(String(site.competitor_domains_json || '[]')) as string[]; } catch { configured = []; }
        if (!configured.map((item) => item.toLowerCase()).includes(input.domain)) {
          throw new Error('Competitor domain is not configured for this site');
        }
        return fetchCompetitorSitemap(input.domain);
      },
    })
    .register({
      name: 'fetch_autocomplete', replaySafety: 'repeatable', version: 2,
      preserveOutputSize: true, description: 'Fetch search autocomplete suggestions targeted to the current Run locale and region.',
      capability: 'external', inputSchema: z.object({ seed: z.string().trim().min(1).max(200), judgment_summary: judgmentSchema }), outputSchema: z.object({
        seed: z.string(), suggestions: z.array(z.string()), error: z.string(),
      }), timeoutMs: 15_000, retryable: true, approval: 'never',
      execute: async (input, context) => {
        const locale = await resolveLocale(context.runId);
        if (!locale) throw new Error('Research task lost its locale identity');
        return fetchAutocomplete(input.seed, locale);
      },
    })
    .register({
      // The cheap, fast half of the evidence pair. It exists so a small factual
      // gap does not have to be paid for with a Deep Research task: looking up
      // one competitor's positioning page, confirming a term is really used in
      // the target market, or checking what a SERP looks like are seconds of
      // work, not minutes. It cannot establish market structure — that is what
      // deep_research is for, and the prompt says which to reach for when.
      name: 'strategy_search_web', replaySafety: 'repeatable', version: 2, capability: 'external',
      preserveOutputSize: true,
      description: 'Set country to a two-letter market when needed; otherwise the strategy locale region or provider default US is used. Fast web search returning page excerpts for up to 6 queries. Use it to close one specific factual gap: confirm a term is really searched in this market, look at a named competitor page, check what a representative SERP contains, or verify a claim before relying on it. It returns page snippets, not analysis, and cannot establish market structure, competitor positioning, or opportunity size — use deep_research for those.',
      inputSchema: z.object({ queries: z.array(z.string().trim().min(1).max(300)).min(1).max(6), country: z.string().regex(/^[A-Z]{2}$/).optional(), judgment_summary: judgmentSchema }),
      outputSchema: z.array(citationSchema), timeoutMs: 60_000, retryable: true, approval: 'never',
      execute: async (input, context) => { const locale = await resolveLocale(context.runId); return searchTaskWeb(env, context.runId, input.queries, context.signal, input.country || (locale ? new Intl.Locale(locale).region : undefined)); },
    })
    .register({
      name: 'deep_research', replaySafety: 'idempotent', version: 5, description: 'Delegate a scoped research brief to Firecrawl. You author the research question and brief from your available business context; no user-written research topic is required. Include relevant facts and uncertainties in context because Firecrawl cannot see your conversation. Returns a saved report, provider-supplied citations and explicit unknowns. Provider excerpts are not independently verified page snapshots. Judge sufficiency and decide whether to ask a new focused question or wait. Supply only necessary non-secret business context. resume_task_id resumes status retrieval for the same saved provider job; it does not restart research or revise its brief.', capability: 'external',
      inputSchema: researchRequestSchema.extend({ resume_task_id: z.string().default(''), judgment_summary: judgmentSchema }).superRefine((value, context) => {
        if (JSON.stringify(researchRequestSchema.parse(value)).length > 9000) context.addIssue({ code: 'custom', path: ['context'], message: 'Narrow the research brief to at most 9000 serialized characters so it fits the provider prompt limit.' });
      }),
      outputSchema: researchResultSchema,
      timeoutMs: 60_000, retryable: false, approval: 'never', executionMode: 'durable_async', preserveOutputSize: true,
    });
}
