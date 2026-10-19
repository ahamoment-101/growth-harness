import { strategyTaskTools } from './strategy-task';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentDefinition } from './definitions';
import { createStrategyResearchToolRegistry, isPublicResearchDomain } from './strategy-tools';

describe('strategy research tool registry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('registers every formal strategy tool and keeps synthetic tools isolated', () => {
    const registry = strategyTaskTools({ env: {} as never, definition: agentDefinition('strategy_research') });
    const definition = agentDefinition('strategy_research');
    for (const name of definition.tools) expect(() => registry.resolve(definition, name)).not.toThrow();
    expect(() => registry.resolve(definition, 'read_synthetic_context')).toThrow(/not allowed/);
  });

  it('rejects local and private sitemap targets', () => {
    expect(isPublicResearchDomain('example.com')).toBe(true);
    expect(isPublicResearchDomain('localhost')).toBe(false);
    expect(isPublicResearchDomain('127.0.0.1')).toBe(false);
    expect(isPublicResearchDomain('192.168.1.2')).toBe(false);
    expect(isPublicResearchDomain('service.local')).toBe(false);
  });

  it('requires the formal durable adapter for deep research', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      request_id: 'research-registry', status: 'completed', content: 'Cited strategic report',
      sources: [{ title: 'Source', url: 'https://example.com/evidence' }], response_time: 3,
    }), { status: 201 })));
    const registry = createStrategyResearchToolRegistry({ FIRECRAWL_API_KEY: 'search-test' } as never);
    const definition = agentDefinition('strategy_research');
    const tool = registry.resolve(definition, 'deep_research');

    expect(tool).toMatchObject({ version: 5, timeoutMs: 60_000, retryable: false, approval: 'never', executionMode: 'durable_async' });
    await expect(registry.execute(definition, 'deep_research', {
      research_question: 'Which market shift could materially change this SEO strategy?',
      model: 'mini',
      judgment_summary: 'Cross-source domain judgment needs to be supplemented.',
    }, {
      runId: 'run-1', workspaceId: 'workspace-1', siteId: 'site-1', idempotencyKey: 'call-1',
    })).rejects.toThrow('requires durable async execution');
    expect(fetch).not.toHaveBeenCalled();
  });
});
