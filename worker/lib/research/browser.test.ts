import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWebPage } from './browser';
import type { RuntimeAgentEnv } from '../../agent-runtime/env';
vi.mock('../../agent-runtime/task-usage', () => ({ reserveExternalUsage: vi.fn(async () => 'receipt') }));
const run = vi.fn(async () => ({}));
const bind = vi.fn(() => ({ run }));
const env = { FIRECRAWL_API_KEY: 'fixture', DB: { prepare: () => ({ bind }) } } as unknown as RuntimeAgentEnv;
afterEach(() => vi.unstubAllGlobals());
describe('Firecrawl page acquisition', () => {
  it('requests Markdown over the scrape API and preserves full content', async () => {
    const fetch = vi.fn(async () => Response.json({ success: true, data: { markdown: '# Real page', metadata: { creditsUsed: 1 } } }));
    vi.stubGlobal('fetch', fetch);
    expect(await readWebPage(env, 'run', 'https://example.com')).toBe('# Real page');
    expect(fetch.mock.calls[0]).toMatchObject(['https://api.firecrawl.dev/v2/scrape', { method: 'POST' }]);
    expect(bind).toHaveBeenCalledWith(1, 'receipt');
  });
  it('rejects missing configuration, private URLs and empty provider output', async () => {
    await expect(readWebPage({ ...env, FIRECRAWL_API_KEY: '' }, 'run', 'https://example.com')).rejects.toThrow('FIRECRAWL_API_KEY');
    await expect(readWebPage(env, 'run', 'http://127.0.0.1')).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, data: { markdown: '' } })));
    await expect(readWebPage(env, 'run', 'https://example.com')).rejects.toThrow('no readable page');
  });
  it('reports HTTP failures without accepting them as evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    await expect(readWebPage(env, 'run', 'https://example.com')).rejects.toThrow('HTTP 429');
  });
});
