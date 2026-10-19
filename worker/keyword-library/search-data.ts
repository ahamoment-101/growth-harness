import type { KeywordCountryMetrics, KeywordSearchData, KeywordSerpSnapshot } from '../../shared/keyword-library';
import {
  fetchKeywordMetrics, fetchSerp, keywordKey, providerLanguage, type DataforseoCredentials,
} from '../lib/research/dataforseo';

/** Search data belongs to a site and a language; the country is part of each observation. */
export type SearchDataScope = { workspace_id: string; site_id: string; locale: string };

type Observation = { keyword: string; country: string; kind: 'metrics' | 'serp'; payload: KeywordCountryMetrics | KeywordSerpSnapshot; source: string; observed_at: string };

async function record(db: D1Database, scope: SearchDataScope, observations: Observation[], cost_usd: number) {
  const language = providerLanguage(scope.locale);
  const request_id = crypto.randomUUID();
  const insert = `insert into keyword_search_observations
    (id,workspace_id,site_id,language,country,keyword_key,keyword,kind,payload_json,source,request_id,request_cost_usd,observed_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const statements = observations.map(o => db.prepare(insert).bind(
    crypto.randomUUID(), scope.workspace_id, scope.site_id, language, o.country, keywordKey(o.keyword), o.keyword, o.kind,
    JSON.stringify(o.payload), o.source, request_id, cost_usd, o.observed_at,
  ));
  // Bounded batches: one metrics call can return up to 700 keywords.
  for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
  return request_id;
}

/**
 * Look up volume, difficulty, intent, CPC and 12-month trend for keywords in one country, and
 * record every result, including keywords the provider has no data for. The provider charges
 * the call even when some keywords have no data.
 */
export async function lookupKeywordMetrics(db: D1Database, credentials: DataforseoCredentials, scope: SearchDataScope,
  input: { country: string; keywords: string[]; signal?: AbortSignal }) {
  const result = await fetchKeywordMetrics({ credentials, keywords: input.keywords, country: input.country, locale: scope.locale, signal: input.signal });
  const request_id = await record(db, scope, result.rows.map(row => ({
    keyword: row.keyword, country: row.metrics.country, kind: 'metrics', payload: row.metrics, source: row.metrics.source, observed_at: row.metrics.observed_at,
  })), result.cost_usd);
  return { ...result, request_id };
}

/** Look up and record the live organic results page for one keyword in one country. */
export async function lookupSerp(db: D1Database, credentials: DataforseoCredentials, scope: SearchDataScope,
  input: { country: string; keyword: string; depth?: number; signal?: AbortSignal }) {
  const result = await fetchSerp({ credentials, keyword: input.keyword, country: input.country, locale: scope.locale, depth: input.depth, signal: input.signal });
  const request_id = await record(db, scope, [{
    keyword: input.keyword, country: result.snapshot.country, kind: 'serp', payload: result.snapshot, source: result.snapshot.source, observed_at: result.snapshot.observed_at,
  }], result.cost_usd);
  return { ...result, request_id };
}

/** Latest recorded search data per keyword (by normalized name), one metrics row and one SERP per country. */
export async function readSearchData(db: D1Database, scope: SearchDataScope, keywords: string[]): Promise<Map<string, KeywordSearchData>> {
  const keys = [...new Set(keywords.map(keywordKey))];
  const found = new Map<string, KeywordSearchData>();
  if (!keys.length) return found;
  const language = providerLanguage(scope.locale);
  // D1 allows 100 bound parameters per statement; three are the scope.
  const rows: Array<{ keyword_key: string; kind: 'metrics' | 'serp'; payload_json: string }> = [];
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const page = await db.prepare(`select keyword_key, kind, payload_json from (
        select keyword_key, kind, country, payload_json,
          row_number() over (partition by keyword_key, kind, country order by observed_at desc, rowid desc) as n
        from keyword_search_observations
        where workspace_id=? and site_id=? and language=? and keyword_key in (${chunk.map(() => '?').join(',')})
      ) where n = 1 order by keyword_key, kind, country`)
      .bind(scope.workspace_id, scope.site_id, language, ...chunk).all<{ keyword_key: string; kind: 'metrics' | 'serp'; payload_json: string }>();
    rows.push(...page.results);
  }
  for (const row of rows) {
    const data = found.get(row.keyword_key) || { metrics: [], serp: [] };
    if (row.kind === 'metrics') data.metrics.push(JSON.parse(row.payload_json) as KeywordCountryMetrics);
    else data.serp.push(JSON.parse(row.payload_json) as KeywordSerpSnapshot);
    found.set(row.keyword_key, data);
  }
  return found;
}
