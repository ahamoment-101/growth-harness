import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchWeb } from './search';
import { publicResearchUrl } from './url';
afterEach(() => vi.unstubAllGlobals());
describe('Firecrawl search provider boundary', () => {
  it('uses v2 search only, deduplicates queries and reads the actual data.web array', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ success: true, creditsUsed: 2, data: { web: [
      { url: 'https://example.com/page', title: 'Source', description: 'Snippet' },
      { url: 'http://127.0.0.1/private', title: 'Private' },
    ] } })));
    vi.stubGlobal('fetch', request);
    const usage = vi.fn(); const reserve = vi.fn();
    const result = await searchWeb({ apiKey: 'fixture', queries: ['  evidence ', 'Evidence'], beforeRequest: reserve, onUsage: usage });
    expect(request).toHaveBeenCalledOnce(); expect(reserve).toHaveBeenCalledOnce(); expect(usage).toHaveBeenCalledWith(2);
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.firecrawl.dev/v2/search');
    expect(JSON.parse(String(init.body))).toEqual({ query: 'Evidence', limit: 6, sources: ['web'], timeout: 15000 });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture' });
    expect(result).toEqual([{ url: 'https://example.com/page', title: 'Source', content: 'Snippet', query: 'Evidence' }]);
  });
  it('passes an explicit search country instead of silently using US', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { web: [] } })));
    vi.stubGlobal('fetch', request);
    await searchWeb({ apiKey: 'fixture', queries: ['tradutor'], country: 'BR' });
    const init = (request.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).country).toBe('BR');
  });
  it('distinguishes empty results, provider rejection, malformed data, and missing configuration', async () => {
    await expect(searchWeb({ apiKey: '', queries: ['x'] })).rejects.toThrow('FIRECRAWL_API_KEY');
    await expect(searchWeb({ apiKey: 'fixture', queries: ['x'.repeat(501)] })).rejects.toThrow('500');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: { web: [] } }))));
    expect(await searchWeb({ apiKey: 'fixture', queries: ['x'] })).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private provider payload', { status: 429 })));
    await expect(searchWeb({ apiKey: 'fixture', queries: ['x'] })).rejects.toThrow('HTTP 429');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }))));
    await expect(searchWeb({ apiKey: 'fixture', queries: ['x'] })).rejects.toThrow('malformed');
  });
  it('rejects credentialed, IP, private and non-web URLs before browser dispatch', () => {
    for (const url of ['http://localhost/', 'http://0x7f000001/', 'http://[::1]/', 'http://10.0.0.1/', 'https://a:b@example.com/', 'file:///etc/passwd', 'https://host.internal/', 'https://example.com:8080/']) expect(() => publicResearchUrl(url)).toThrow();
    expect(publicResearchUrl('https://example.com/page#part')).toBe('https://example.com/page');
  });
});

it('returns successful batch work and provider limit evidence without exposing the API key', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, creditsUsed: 2, data: { web: [{ url: 'https://example.com/evidence', title: 'Evidence', description: 'Verified result' }] } })))
    .mockResolvedValueOnce(new Response('Rate limit for secret-fixture', { status: 429, headers: { 'retry-after': '45', 'x-request-id': 'request-2' } }));
  vi.stubGlobal('fetch', request);
  const { SearchHttpError } = await import('./search');
  try {
    await searchWeb({ apiKey: 'secret-fixture', queries: ['one', 'two', 'three'] });
    throw new Error('Expected provider rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(SearchHttpError);
    const failure = error as InstanceType<typeof SearchHttpError>;
    expect(failure.progress).toMatchObject({ providerError: 'Rate limit for [redacted]', retryAfter: '45', requestId: 'request-2', completedQueries: ['one'], remainingQueries: ['two', 'three'] });
    expect(failure.progress.results).toHaveLength(1);
    expect(failure.assessment).toMatchObject({ retryable: false, effects: 'preserved', kind: 'rate_limited' });
    expect(failure.assessment.observation?.text).toContain('Verified result');
  }
  expect(request).toHaveBeenCalledTimes(2);
});
