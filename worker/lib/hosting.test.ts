import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Site } from '../types';
import {
  cnameChainPointsTo,
  interpretDns,
  isCloudflareIp,
  isSetupArticle,
  looksCloudflareProxied,
  mergeCnameHops,
  normalizeHost,
  decideHostStatus,
  probePath,
  probeUrl,
  checkHost,
} from './hosting';
import { localePolicyFromCodes, matchBlogPath } from '../blog/seo';

describe('read-only hosting checks', () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockCloudflare(payload: unknown, status = 200) {
    const fetcher = vi.fn(async (input: string, _init?: RequestInit) => {
      if (input.includes('dns-query')) {
        return Response.json({ Status: 0, Answer: input.endsWith('type=A') ? [{ type: 1, data: '104.21.51.26' }] : [] });
      }
      return Response.json(payload, { status });
    });
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }

  it.each([
    [{ success: false, errors: [{ message: 'Invalid token' }] }, 403],
    [{ success: true, result: [] }, 200],
    [{ success: true }, 200],
  ])('does not turn unavailable configuration evidence into a persisted outage', async (payload, status) => {
    const fetcher = mockCloudflare(payload, status as number);
    const site = { id: 'site', domain: 'blog.example.com', domain_status: 'live' } as Site;
    await expect(checkHost({ CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_WORKER_NAME: 'docs-worker' } as Env, site)).rejects.toThrow('original connection status has been preserved');
    expect(site.domain_status).toBe('live');
    expect(fetcher.mock.calls.every(call => call.length === 1 || !(call[1] as RequestInit)?.method || (call[1] as RequestInit)?.method === 'GET')).toBe(true);
  });

  it.each(['programmatic-seo', 'renamed-docs-worker'])('checks the explicitly configured Worker name %s', async workerName => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      expect(init?.method || 'GET').toBe('GET');
      if (input.includes('dns-query')) return Response.json({ Status: 0, Answer: input.endsWith('type=A') ? [{ type: 1, data: '104.21.51.26' }] : [] });
      return Response.json({ success: true, result: input.includes('/workers/routes')
        ? [{ pattern: 'blog.example.com/*', script: workerName }]
        : [{ id: 'zone' }] });
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await checkHost({ CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_WORKER_NAME: workerName } as Env, { domain: 'blog.example.com' } as Site);
    expect(result).toMatchObject({ status: 'live', live: { ok: true } });
    expect(fetcher.mock.calls.every(([url]) => url.includes('cloudflare'))).toBe(true);
  });

  it('reports a different route target without accepting any arbitrary Worker as this installation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('dns-query')) return Response.json({ Status: 0, Answer: input.endsWith('type=A') ? [{ type: 1, data: '104.21.51.26' }] : [] });
      return Response.json({ success: true, result: input.includes('/workers/routes')
        ? [{ pattern: 'blog.example.com/*', script: 'different-worker' }]
        : [{ id: 'zone' }] });
    }));
    const result = await checkHost({ CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_WORKER_NAME: 'docs-worker' } as Env, { domain: 'blog.example.com' } as Site);
    expect(result).toMatchObject({ status: 'error', live: { ok: false } });
    expect(result.live.message).toContain('different-worker');
  });

  it.each([undefined, '', '  '])('preserves connection status when the Worker target is not configured: %s', async workerName => {
    const fetcher = mockCloudflare({ success: true, result: [] });
    const site = { domain: 'blog.example.com', domain_status: 'live' } as Site;
    await expect(checkHost({ CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_WORKER_NAME: workerName } as Env, site)).rejects.toThrow('CLOUDFLARE_WORKER_NAME');
    expect(site.domain_status).toBe('live');
    expect(fetcher.mock.calls.every(([url]) => url.includes('dns-query'))).toBe(true);
  });

  it('does not create routes when no exact route exists', async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      expect(init?.method || 'GET').toBe('GET');
      if (input.includes('dns-query')) return Response.json({ Status: 0, Answer: [{ type: 1, data: '104.21.51.26' }] });
      return Response.json({ success: true, result: input.includes('/workers/routes') ? [] : [{ id: 'zone' }] });
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(checkHost({ CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_WORKER_NAME: 'docs-worker' } as Env, { domain: 'blog.example.com' } as Site)).rejects.toThrow('another route');
  });
});

describe('cnameChainPointsTo', () => {
  it('accepts a direct CNAME to our target', () => {
    expect(cnameChainPointsTo(['docs-worker.example.workers.dev'], 'docs-worker.example.workers.dev')).toBe(true);
  });

  it('follows a chain that ends at our target', () => {
    expect(
      cnameChainPointsTo(['edge.example.net', 'docs-worker.example.workers.dev.'], 'docs-worker.example.workers.dev'),
    ).toBe(true);
  });

  it('rejects records that point elsewhere', () => {
    expect(cnameChainPointsTo(['www.example.com'], 'docs-worker.example.workers.dev')).toBe(false);
    expect(cnameChainPointsTo([], 'docs-worker.example.workers.dev')).toBe(false);
  });

  it('normalizes trailing dots and case', () => {
    expect(normalizeHost('Blog.Example.COM.')).toBe('blog.example.com');
  });
});

describe('interpretDns', () => {
  const target = 'docs-worker.example.workers.dev';

  it('passes a visible CNAME to our target', () => {
    const r = interpretDns({ chain: [target], a: [], aaaa: [], nx: false, target });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('points to');
  });

  it('explains Cloudflare orange-cloud flattening', () => {
    const r = interpretDns({
      chain: [],
      a: ['104.21.51.26', '172.67.219.88'],
      aaaa: ['2606:4700:3037::6815:331a'],
      nx: false,
      target,
    });
    expect(looksCloudflareProxied(r.a, r.aaaa)).toBe(true);
    expect(isCloudflareIp('104.21.51.26')).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/[Dd]o not (?:disable|turn.*off)/);
  });

  it('still rejects non-Cloudflare A records without CNAME', () => {
    const r = interpretDns({ chain: [], a: ['1.2.3.4'], aaaa: [], nx: false, target });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('A/AAAA records');
  });

  it('uses CNAME hops found inside A answers (Cloudflare DoH quirk)', () => {
    const chain = mergeCnameHops([], [target + '.'], []);
    const r = interpretDns({
      chain,
      a: ['104.21.9.26', '172.67.141.45'],
      aaaa: [],
      nx: false,
      target,
    });
    expect(r.ok).toBe(true);
  });
});

describe('decideHostStatus', () => {
  const target = 'docs-worker.example.workers.dev';

  it('treats orange-cloud + our Worker route as live without fetching the hostname', () => {
    const dns = interpretDns({
      chain: [],
      a: ['104.21.51.26', '172.67.219.88'],
      aaaa: ['2606:4700:3036::ac43:db58'],
      nx: false,
      target,
    });
    const r = decideHostStatus(dns, true);
    expect(r.status).toBe('live');
    expect(r.live.ok).toBe(true);
    expect(r.live.message).toContain('open the trial page');
  });

  it('does not call grey-cloud CNAME live until orange cloud is on', () => {
    const dns = interpretDns({ chain: [target], a: ['104.21.9.26'], aaaa: [], nx: false, target });
    const r = decideHostStatus(dns, true);
    expect(r.status).toBe('dns_ok');
    expect(r.live.ok).toBe(false);
    expect(r.live.message).toMatch(/orange cloud/);
  });
});

describe('probe urls', () => {
  it('uses the customer hostname home, matching /live/{siteId}/', () => {
    expect(probePath()).toBe('/');
    expect(probeUrl('blog.example.com')).toBe('https://blog.example.com/');
    expect(isSetupArticle('en', '_setup')).toBe(true);
    expect(isSetupArticle('pt-BR', '_setup')).toBe(false);
  });
});

describe('matchBlogPath', () => {
  it('matches root, sitemap and article paths without /live', () => {
    const policy = localePolicyFromCodes(['en', 'pt-BR']);
    expect(matchBlogPath('/', policy)).toEqual({ kind: 'home' });
    expect(matchBlogPath('/robots.txt', policy)).toEqual({ kind: 'robots' });
    expect(matchBlogPath('/sitemap.xml', policy)).toEqual({ kind: 'sitemap' });
    expect(matchBlogPath('/en/blog', policy)).toEqual({ kind: 'list', locale: 'en', page: 1 });
    expect(matchBlogPath('/en/blog/_setup', policy)).toEqual({ kind: 'article', locale: 'en', slug: '_setup' });
    expect(matchBlogPath('/en/blog/hello', policy)).toEqual({ kind: 'article', locale: 'en', slug: 'hello' });
    expect(matchBlogPath('/pt/blog/ola', policy)).toEqual({ kind: 'article', locale: 'pt-BR', slug: 'ola' });
    expect(matchBlogPath('/s/abc/overview', policy)).toBeNull();
  });
});
