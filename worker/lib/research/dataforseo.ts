import { observedFetch } from '../../agent-runtime/request-accounting';
import type { KeywordCountryMetrics, KeywordSerpSnapshot } from '../../../shared/keyword-library';

// Narrow DataForSEO boundary: two live endpoints, normalized into the library's
// search-data contract. Every call is billed by the provider, including many
// task-level failures, so nothing here retries.

const API = 'https://api.dataforseo.com/v3';
const TIMEOUT_MS = 60_000;
/** keyword_overview accepts up to 700 keywords per task. */
export const MAX_METRIC_KEYWORDS = 700;

/**
 * Countries covered by DataForSEO Labs (ISO 3166-1 alpha-2 → Google geotarget location_code).
 * Source: open-seo src/shared/keyword-locations.ts (MIT), from /v3/dataforseo_labs/locations_and_languages.
 */
export const LABS_LOCATION_CODES: Record<string, number> = {
  AE: 2784, AL: 2008, AM: 2051, AO: 2024, AR: 2032, AT: 2040, AU: 2036, AZ: 2031, BA: 2070, BD: 2050, BE: 2056, BF: 2854,
  BG: 2100, BH: 2048, BO: 2068, BR: 2076, CA: 2124, CH: 2756, CI: 2384, CL: 2152, CM: 2120, CO: 2170, CR: 2188, CY: 2196,
  CZ: 2203, DE: 2276, DK: 2208, DZ: 2012, EC: 2218, EE: 2233, EG: 2818, ES: 2724, FI: 2246, FR: 2250, GB: 2826, GH: 2288,
  GR: 2300, GT: 2320, HK: 2344, HR: 2191, HU: 2348, ID: 2360, IE: 2372, IL: 2376, IN: 2356, IT: 2380, JO: 2400, JP: 2392,
  KE: 2404, KH: 2116, KR: 2410, KZ: 2398, LK: 2144, LT: 2440, LV: 2428, MA: 2504, MC: 2492, MD: 2498, MK: 2807, MM: 2104,
  MT: 2470, MX: 2484, MY: 2458, NG: 2566, NI: 2558, NL: 2528, NO: 2578, NZ: 2554, PA: 2591, PE: 2604, PH: 2608, PK: 2586,
  PL: 2616, PT: 2620, PY: 2600, RO: 2642, RS: 2688, SA: 2682, SE: 2752, SG: 2702, SI: 2705, SK: 2703, SN: 2686, SV: 2222,
  TH: 2764, TN: 2788, TR: 2792, TW: 2158, UA: 2804, US: 2840, UY: 2858, VE: 2862, VN: 2704, ZA: 2710,
};

export type DataforseoCredentials = { login?: string; password?: string };
export type DataforseoErrorKind = 'not_configured' | 'invalid_request' | 'account' | 'billing_or_limit' | 'rate_limited' | 'unavailable' | 'unknown';

/** Provider status and message are preserved verbatim so a person or an Agent can see the exact reason. */
export class DataforseoError extends Error {
  constructor(message: string, readonly details: { kind: DataforseoErrorKind; status_code: number; http_status: number; cost_usd: number }) {
    super(message);
    this.name = 'DataforseoError';
  }
}

function errorKind(httpStatus: number, statusCode: number): DataforseoErrorKind {
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus >= 500 || (statusCode >= 50000 && statusCode < 60000)) return 'unavailable';
  if (httpStatus === 401 || httpStatus === 403 || (statusCode >= 40100 && statusCode < 40200)) return 'account';
  if (statusCode >= 40200 && statusCode < 40300) return 'billing_or_limit';
  if (statusCode >= 40000 && statusCode < 50000) return 'invalid_request';
  return 'unknown';
}

type Task<T> = { status_code?: number; status_message?: string; cost?: number; result?: T[] | null };
type Envelope<T> = { status_code?: number; status_message?: string; cost?: number; tasks?: Array<Task<T>> | null };

async function post<T>(credentials: DataforseoCredentials, path: string, task: Record<string, unknown>, signal?: AbortSignal) {
  if (!credentials.login || !credentials.password) {
    throw new DataforseoError('DataForSEO credentials are not configured', { kind: 'not_configured', status_code: 0, http_status: 0, cost_usd: 0 });
  }
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await observedFetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa(`${credentials.login}:${credentials.password}`)}` },
    body: JSON.stringify([task]),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await response.text();
  let body: Envelope<T> = {};
  try { body = JSON.parse(text) as Envelope<T>; } catch { /* non-JSON error page */ }
  const statusCode = Number(body.status_code || 0);
  if (!response.ok || statusCode !== 20000) {
    throw new DataforseoError(`DataForSEO ${statusCode || response.status}: ${body.status_message || text.slice(0, 300)}`,
      { kind: errorKind(response.status, statusCode), status_code: statusCode, http_status: response.status, cost_usd: Number(body.cost || 0) });
  }
  const first = body.tasks?.[0];
  const taskCode = Number(first?.status_code || 0);
  if (!first || taskCode !== 20000) {
    throw new DataforseoError(`DataForSEO task ${taskCode}: ${first?.status_message || 'missing task'}`,
      { kind: errorKind(response.status, taskCode), status_code: taskCode, http_status: response.status, cost_usd: Number(first?.cost ?? body.cost ?? 0) });
  }
  return { result: first.result?.[0] ?? null, cost_usd: Number(first.cost ?? body.cost ?? 0) };
}

export function locationCode(country: string): number {
  const code = LABS_LOCATION_CODES[country.toUpperCase()];
  if (!code) throw new DataforseoError(`Country ${country} is not covered by DataForSEO Labs`, { kind: 'invalid_request', status_code: 0, http_status: 0, cost_usd: 0 });
  return code;
}

/** DataForSEO takes the bare language subtag ("pt" for pt-BR). */
export function providerLanguage(locale: string): string {
  return new Intl.Locale(locale).language;
}

export const keywordKey = (keyword: string) => keyword.trim().normalize('NFC').toLowerCase();

type OverviewItem = {
  keyword?: string;
  keyword_info?: { search_volume?: number | null; cpc?: number | null; monthly_searches?: Array<{ year?: number; month?: number; search_volume?: number | null }> | null } | null;
  keyword_properties?: { keyword_difficulty?: number | null } | null;
  search_intent_info?: { main_intent?: string | null } | null;
};

export type KeywordMetricsResult = { rows: Array<{ keyword: string; metrics: KeywordCountryMetrics }>; cost_usd: number };

/**
 * Labs keyword_overview for one country and language. Every requested keyword gets a row;
 * a keyword the provider has no data for is returned with null values (asked, no data).
 */
export async function fetchKeywordMetrics(input: {
  credentials: DataforseoCredentials; keywords: string[]; country: string; locale: string; signal?: AbortSignal; now?: () => Date;
}): Promise<KeywordMetricsResult> {
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.keywords) {
    const key = keywordKey(raw);
    if (key && !seen.has(key)) { seen.add(key); keywords.push(raw.trim()); }
  }
  if (!keywords.length || keywords.length > MAX_METRIC_KEYWORDS) {
    throw new DataforseoError(`Keyword metrics require 1–${MAX_METRIC_KEYWORDS} keywords`, { kind: 'invalid_request', status_code: 0, http_status: 0, cost_usd: 0 });
  }
  const country = input.country.toUpperCase();
  const { result, cost_usd } = await post<{ items?: OverviewItem[] | null }>(input.credentials, '/dataforseo_labs/google/keyword_overview/live', {
    keywords, location_code: locationCode(country), language_code: providerLanguage(input.locale),
  }, input.signal);
  const observed_at = (input.now?.() ?? new Date()).toISOString();
  const byKey = new Map((result?.items || []).filter(item => item.keyword).map(item => [keywordKey(item.keyword!), item]));
  return {
    cost_usd,
    rows: keywords.map(keyword => {
      const item = byKey.get(keywordKey(keyword));
      const info = item?.keyword_info;
      const monthly = (info?.monthly_searches || [])
        .filter(m => m.year && m.month)
        .map(m => ({ month: `${m.year}-${String(m.month).padStart(2, '0')}`, volume: m.search_volume ?? null }))
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-12);
      return { keyword, metrics: {
        country, search_volume: info?.search_volume ?? null, keyword_difficulty: item?.keyword_properties?.keyword_difficulty ?? null,
        intent: item?.search_intent_info?.main_intent ?? null, cpc_usd: info?.cpc ?? null, monthly,
        source: 'DataForSEO Labs', observed_at,
      } };
    }),
  };
}

type SerpItem = { type?: string; rank_group?: number | null; domain?: string | null; url?: string | null; title?: string | null };

/** Live Google organic results. Ranks count organic listings only (rank_group), not SERP features. */
export async function fetchSerp(input: {
  credentials: DataforseoCredentials; keyword: string; country: string; locale: string; depth?: number; signal?: AbortSignal; now?: () => Date;
}): Promise<{ snapshot: KeywordSerpSnapshot; cost_usd: number }> {
  const keyword = input.keyword.trim();
  if (!keyword || keyword.length > 700) throw new DataforseoError('A SERP lookup needs one keyword of at most 700 characters', { kind: 'invalid_request', status_code: 0, http_status: 0, cost_usd: 0 });
  const depth = Math.min(100, Math.max(10, Math.round((input.depth ?? 10) / 10) * 10));
  const country = input.country.toUpperCase();
  const { result, cost_usd } = await post<{ item_types?: string[] | null; items?: SerpItem[] | null }>(input.credentials, '/serp/google/organic/live/advanced', {
    keyword, location_code: locationCode(country), language_code: providerLanguage(input.locale), depth,
  }, input.signal);
  const results = (result?.items || [])
    .filter(item => item.type === 'organic' && item.domain && item.url && typeof item.rank_group === 'number')
    .sort((a, b) => a.rank_group! - b.rank_group!)
    .map(item => ({ rank: item.rank_group!, domain: item.domain!, url: item.url!, title: item.title || '' }));
  const features = [...new Set((result?.item_types || []).filter(type => type !== 'organic' && type !== 'paid'))];
  return { cost_usd, snapshot: { country, features, results, source: 'DataForSEO SERP', observed_at: (input.now?.() ?? new Date()).toISOString() } };
}
