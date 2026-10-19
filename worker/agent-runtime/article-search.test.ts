import { expect, it, vi } from 'vitest';
import { createArticleProductionToolRegistry } from './article-production-tools';
import { agentDefinition } from './definitions';
import type { RuntimeAgentEnv } from './env';
import { searchTaskWeb } from './task-usage';

vi.mock('./task-usage', () => ({ searchTaskWeb: vi.fn() }));

it('uses the existing accounted search with the author Run and preserves evidence and failures', async () => {
  const env = {} as RuntimeAgentEnv;
  const registry = createArticleProductionToolRegistry(env);
  const definition = agentDefinition('article_production');
  const result = [{ url: 'https://example.com/pricing', title: 'Pricing', content: 'Public pricing snippet' }];
  vi.mocked(searchTaskWeb).mockResolvedValueOnce(result);
  const context = { runId: 'author-run', workspaceId: 'w', siteId: 's', idempotencyKey: 'operation' };
  const input = { queries: ['current product pricing'], country: 'US', judgment_summary: 'Verify comparison facts' };
  expect(await registry.execute(definition, 'article_search_web', input, context)).toEqual(result);
  expect(searchTaskWeb).toHaveBeenCalledWith(env, 'author-run', input.queries, expect.any(AbortSignal), 'US');
  const failure = new Error('Dependency unavailable');
  vi.mocked(searchTaskWeb).mockRejectedValueOnce(failure);
  await expect(registry.execute(definition, 'article_search_web', input, context)).rejects.toThrow(failure);
});
