import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataforseoError, fetchKeywordMetrics, fetchSerp, providerLanguage } from './dataforseo';

const credentials = { login: 'user@example.com', password: 'secret' };
const now = () => new Date('2026-09-23T08:00:00.000Z');
function reply(body: unknown, status = 200) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const ok = (result: unknown, cost = 0.0102) => ({ status_code: 20000, status_message: 'Ok.', cost, tasks: [{ status_code: 20000, status_message: 'Ok.', cost, result: [result] }] });

afterEach(() => vi.unstubAllGlobals());

describe('DataForSEO keyword metrics', () => {
  it('sends one Labs task for the country and language and returns a row for every keyword', async () => {
    const fetch = reply(ok({ items: [{
      keyword: 'email formal em inglês',
      keyword_info: { search_volume: 1900, cpc: 0.42, monthly_searches: [
        { year: 2026, month: 8, search_volume: 2100 }, { year: 2025, month: 9, search_volume: 1500 },
      ] },
      keyword_properties: { keyword_difficulty: 24 },
      search_intent_info: { main_intent: 'informational' },
    }] }));
    const result = await fetchKeywordMetrics({ credentials, keywords: ['Email formal em inglês', 'agradecimento email em inglês', 'email formal em inglês '], country: 'br', locale: 'pt-BR', now });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Basic ${btoa('user@example.com:secret')}`);
    expect(JSON.parse(String(init.body))).toEqual([{ keywords: ['Email formal em inglês', 'agradecimento email em inglês'], location_code: 2076, language_code: 'pt' }]);
    expect(result.cost_usd).toBe(0.0102);
    expect(result.rows).toEqual([
      { keyword: 'Email formal em inglês', metrics: { country: 'BR', search_volume: 1900, keyword_difficulty: 24, intent: 'informational', cpc_usd: 0.42,
        monthly: [{ month: '2025-09', volume: 1500 }, { month: '2026-08', volume: 2100 }], source: 'DataForSEO Labs', observed_at: '2026-09-23T08:00:00.000Z' } },
      { keyword: 'agradecimento email em inglês', metrics: { country: 'BR', search_volume: null, keyword_difficulty: null, intent: null, cpc_usd: null,
        monthly: [], source: 'DataForSEO Labs', observed_at: '2026-09-23T08:00:00.000Z' } },
    ]);
  });

  it('rejects countries outside Labs coverage before calling the provider', async () => {
    const fetch = reply(ok({ items: [] }));
    await expect(fetchKeywordMetrics({ credentials, keywords: ['x'], country: 'IS', locale: 'is' })).rejects.toMatchObject({ details: { kind: 'invalid_request' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports missing credentials without calling the provider', async () => {
    const fetch = reply(ok({ items: [] }));
    await expect(fetchKeywordMetrics({ credentials: {}, keywords: ['x'], country: 'US', locale: 'en' })).rejects.toMatchObject({ details: { kind: 'not_configured' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the provider status and message for account, task and HTTP failures', async () => {
    reply({ status_code: 40104, status_message: 'Please verify your account before using the API.', cost: 0, tasks: null });
    const account = await fetchKeywordMetrics({ credentials, keywords: ['x'], country: 'US', locale: 'en' }).catch(e => e);
    expect(account).toBeInstanceOf(DataforseoError);
    expect(account.message).toContain('Please verify your account');
    expect(account.details).toEqual({ kind: 'account', status_code: 40104, http_status: 200, cost_usd: 0 });

    reply({ status_code: 20000, cost: 0.01, tasks: [{ status_code: 40501, status_message: 'Invalid Field: language_code.', cost: 0.01, result: null }] });
    const task = await fetchKeywordMetrics({ credentials, keywords: ['x'], country: 'US', locale: 'en' }).catch(e => e);
    expect(task.details).toEqual({ kind: 'invalid_request', status_code: 40501, http_status: 200, cost_usd: 0.01 });

    reply({ status_code: 50000, status_message: 'Internal Error.' }, 500);
    const server = await fetchKeywordMetrics({ credentials, keywords: ['x'], country: 'US', locale: 'en' }).catch(e => e);
    expect(server.details.kind).toBe('unavailable');
  });
});

describe('DataForSEO SERP', () => {
  it('counts organic listings only and lists SERP features', async () => {
    const fetch = reply(ok({ item_types: ['ai_overview', 'organic', 'people_also_ask', 'paid'], items: [
      { type: 'ai_overview', rank_group: 1 },
      { type: 'organic', rank_group: 2, domain: 'b.com', url: 'https://b.com/x', title: 'B' },
      { type: 'people_also_ask', rank_group: 1 },
      { type: 'organic', rank_group: 1, domain: 'a.com', url: 'https://a.com/', title: 'A' },
    ] }, 0.002));
    const result = await fetchSerp({ credentials, keyword: 'email formal em inglês', country: 'BR', locale: 'pt-BR', depth: 23, now });
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual([{ keyword: 'email formal em inglês', location_code: 2076, language_code: 'pt', depth: 20 }]);
    expect(result).toEqual({ cost_usd: 0.002, snapshot: {
      country: 'BR', features: ['ai_overview', 'people_also_ask'], source: 'DataForSEO SERP', observed_at: '2026-09-23T08:00:00.000Z',
      results: [{ rank: 1, domain: 'a.com', url: 'https://a.com/', title: 'A' }, { rank: 2, domain: 'b.com', url: 'https://b.com/x', title: 'B' }],
    } });
  });

  it('maps locales to the bare provider language', () => {
    expect(providerLanguage('pt-BR')).toBe('pt');
    expect(providerLanguage('en')).toBe('en');
  });
});
