import { ToolExecutionError } from '../../agent-runtime/tool-failure';
import { observedFetch } from '../../agent-runtime/request-accounting';
import type { UrlCitation } from '../llm';
import { publicResearchUrl } from './url';

export class SearchHttpError extends ToolExecutionError {
  constructor(public status: number, readonly progress: {
    providerError: string; requestId: string; retryAfter: string | null;
    completedQueries: string[]; remainingQueries: string[]; results: UrlCitation[];
  } = { providerError: '', requestId: '', retryAfter: null, completedQueries: [], remainingQueries: [], results: [] }) {
    super(`Web search HTTP ${status}`, {
      kind: status === 429 ? 'rate_limited' : 'unknown',
      // Do not replay an entire partially completed batch automatically.
      retryable: false, effects: progress.completedQueries.length ? 'preserved' : 'none',
      guidance: 'Firecrawl rejected this search request. Completed queries and their results are preserved in the observation. Remaining queries have no returned results. Provider charges are accounted separately. No business document was modified by this search.',
      observation: { requestId: progress.requestId, stopReason: `http_${status}`, text: JSON.stringify(progress) },
    });
    this.name = 'SearchHttpError';
  }
}

function safeProviderText(text: string, apiKey: string): string {
  return text.split(apiKey).join('[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

// Narrow provider boundary: callers retain the existing citation contract.
export async function searchWeb(input: { apiKey: string; queries: string[]; signal?: AbortSignal; country?: string; beforeRequest?: () => Promise<void>; onUsage?: (credits: number | null) => Promise<void> }): Promise<UrlCitation[]> {
  if (!input.apiKey) throw new Error('FIRECRAWL_API_KEY is not configured');
  const queries = [...new Map(input.queries.map(q => [q.trim().toLowerCase(), q.trim()])).values()].filter(Boolean);
  if (!queries.length || queries.length > 6) throw new Error('Web search requires 1–6 queries');
  if (queries.some(query => query.length > 500)) throw new Error('Firecrawl search query exceeds 500 characters');
  if (input.country && !/^[A-Z]{2}$/.test(input.country)) throw new Error('Search country must be a two-letter country code');
  const citations = new Map<string, UrlCitation>();
  const completedQueries: string[] = [];
  // Sequential requests respect low-concurrency provider plans; caller bounds work.
  for (const query of queries) {
    await input.beforeRequest?.();
    const res = await observedFetch('https://api.firecrawl.dev/v2/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
      // Search only: page reading uses a separate Firecrawl scrape request.
      body: JSON.stringify({ query, limit: 6, sources: ['web'], timeout: 15000, ...(input.country ? { country: input.country } : {}) }),
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const providerError = safeProviderText(await res.text(), input.apiKey);
      throw new SearchHttpError(res.status, {
        providerError, requestId: res.headers.get('x-request-id') || res.headers.get('request-id') || '',
        retryAfter: res.headers.get('retry-after'), completedQueries: [...completedQueries],
        remainingQueries: queries.slice(completedQueries.length), results: [...citations.values()],
      });
    }
    const response = await res.json() as { success: boolean; creditsUsed?: number; data?: { web?: Array<{ url?: string; title?: string; description?: string }> } };
    if (!response.success || !response.data) throw new Error('Web search returned an unsuccessful response');
    await input.onUsage?.(typeof response.creditsUsed === 'number' && Number.isFinite(response.creditsUsed) ? Math.max(0, response.creditsUsed) : null);
    const data = response.data;
    if (!Array.isArray(data.web)) throw new Error('Web search returned malformed results');
    for (const item of data.web || []) {
      let url: string; try { url = publicResearchUrl(String(item.url || '')); } catch { continue; }
      citations.set(url, { url, title: String(item.title || '').slice(0, 500), content: String(item.description || '').slice(0, 2000), query });
    }
    completedQueries.push(query);
  }
  return [...citations.values()];
}
