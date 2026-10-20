import { z } from 'zod';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { requireTask, type AgentTask } from '../agent-runtime/task-store';
import { ToolExecutionError, type ToolFailureKind } from '../agent-runtime/tool-failure';
import type { ToolRegistry } from '../agent-runtime/tools';
import { DataforseoError, LABS_LOCATION_CODES, MAX_METRIC_KEYWORDS } from '../lib/research/dataforseo';
import { lookupKeywordMetrics, lookupSerp, readSearchData } from './search-data';

export function keywordSearchAvailability(env: RuntimeAgentEnv) {
  const missing = (['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'] as const).filter(key => !env[key]?.trim());
  return { provider: 'DataForSEO', configured: missing.length === 0, missing };
}

export const KEYWORD_SEARCH_INSTRUCTIONS = `
## Optional measured search data
DataForSEO is an optional paid source. read_keyword_search_data reports current configuration and previously saved observations for keywords in your task language. Read saved data before buying fresh observations; judge freshness by country, source and observed_at.
When configured, lookup_keyword_metrics obtains country-specific search volume, difficulty, intent, CPC and monthly trends. lookup_keyword_serp obtains organic ranks and results-page features for one expression and country. You choose whether these observations would change your decision, which expressions and country to query, and whether existing evidence is sufficient. No query is mandatory.
Calls are billed separately by DataForSEO, including some failures and missing data. A missing value is unknown, never zero. Preserve the returned source, country, timestamp and request_id when citing results. Provider metrics are estimates, not a promise of traffic, rankings or conversions.
When unconfigured or unavailable, the existing autocomplete, web research, business documents, library and configured GSC tools remain available. Their own configuration requirements still apply. There is no automatic substitute for measured volume or difficulty. Record gaps honestly; all existing completion outcomes remain available.`;

/** Domain-local tools; task identity and language are host-owned, country and keywords are Agent choices. */
export function registerKeywordSearchTools(registry: ToolRegistry, env: RuntimeAgentEnv, task: AgentTask, locale: string) {
  const common = { version: 1, timeoutMs: 75_000, retryable: false, approval: 'never' as const, preserveOutputSize: true };
  const country = z.enum(Object.keys(LABS_LOCATION_CODES) as [string, ...string[]]).describe('Supported country code; choose the market to observe independently of the task language.');
  const keyword = z.string().trim().min(1);
  const scope = () => ({ workspace_id: task.workspace_id, site_id: task.site_id, locale });
  const db = env.DB as unknown as D1Database;
  const credentials = () => ({ login: env.DATAFORSEO_LOGIN?.trim(), password: env.DATAFORSEO_PASSWORD?.trim() });
  const paid = async <T>(invoke: () => Promise<T>): Promise<T> => {
    // Revalidate before dispatch; persistence uses the same execution-fenced DB.
    await requireTask(env.DB, task.active_run_id);
    try {
      return await invoke();
    } catch (error) {
      if (!(error instanceof DataforseoError)) throw error; // Unknown effects retain Runtime reconciliation.
      const kinds: Record<string, ToolFailureKind> = { account: 'not_authorized', billing_or_limit: 'quota_exhausted', unavailable: 'transient' };
      const kind = kinds[error.details.kind] || error.details.kind as ToolFailureKind;
      // Do not expose arbitrary provider response text: it may echo credentials.
      throw new ToolExecutionError(`DataForSEO ${error.details.kind}: HTTP ${error.details.http_status}, status ${error.details.status_code}, reported cost USD ${error.details.cost_usd}.`, {
        kind, retryable: false, effects: error.details.cost_usd ? 'preserved' : 'none',
        guidance: error.details.kind === 'not_configured'
          ? 'Both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are required for this optional query. Existing research tools and saved observations remain available.'
          : 'No new search observations were saved. Earlier observations remain available. The provider returned the status and reported charge above; account and request conditions determine whether another query can succeed.',
      });
    }
  };
  registry.register({ ...common, name: 'read_keyword_search_data', capability: 'read',
    description: 'Read saved keyword metrics and SERP observations for this task language, across countries, without a provider call. Also reports whether optional DataForSEO credentials are configured. An empty keyword list checks configuration only.',
    inputSchema: z.object({ keywords: z.array(keyword).default([]) }).strict(), outputSchema: z.unknown(),
    execute: async args => {
      await requireTask(env.DB, task.active_run_id);
      const data = await readSearchData(db, scope(), args.keywords);
      return { ...keywordSearchAvailability(env), locale, observations: [...data].map(([keyword, data]) => ({ keyword, ...data })) };
    },
  });
  registry.register({ ...common, name: 'lookup_keyword_metrics', capability: 'external', replaySafety: 'unreconciled',
    description: 'Optional paid DataForSEO query: obtain and save keyword volume, difficulty, intent, CPC and monthly trends in one country. Language and site come from this task. Missing data stays null. Read existing observations before deciding whether fresh data is needed.',
    inputSchema: z.object({ country, keywords: z.array(keyword).min(1).max(MAX_METRIC_KEYWORDS) }).strict(), outputSchema: z.unknown(),
    execute: (args, context) => paid(() => lookupKeywordMetrics(db, credentials(), scope(), { ...args, signal: context.signal })),
  });
  registry.register({ ...common, name: 'lookup_keyword_serp', capability: 'external', replaySafety: 'unreconciled',
    description: 'Optional paid DataForSEO query: obtain and save organic search results and SERP features for one keyword and country. Language and site come from this task. Depth follows the provider range of 10 to 100 results in steps of 10.',
    inputSchema: z.object({ country, keyword: keyword.max(700), depth: z.number().int().min(10).max(100).multipleOf(10).default(10) }).strict(), outputSchema: z.unknown(),
    execute: (args, context) => paid(() => lookupSerp(db, credentials(), scope(), { ...args, signal: context.signal })),
  });
}
