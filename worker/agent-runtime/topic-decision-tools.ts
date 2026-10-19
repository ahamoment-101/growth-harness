import { registerTopicContextTool } from './topic-context-tools';
import { mountLibraryTools } from '../keyword-library/agent-tools';
import { z } from 'zod';
import { searchWeb } from '../lib/research/search';
import type { RuntimeAgentEnv } from './env';
import { registerPublishedArticleTools } from './published-article-tools';
import { ToolRegistry } from './tools';

const judgmentSchema = z.string().trim().min(1).max(1000);
const MAX_TOPIC_WEB_RESULTS = 12;

export const topicSearchWebInputSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(300)).min(1).max(3),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  judgment_summary: judgmentSchema,
});


export type TopicWebEvidence = { ref?: string; url: string; title: string; content: string; query?: string };

export function normalizeTopicWebEvidence(results: TopicWebEvidence[]): TopicWebEvidence[] {
  return results.slice(0, MAX_TOPIC_WEB_RESULTS).flatMap((result, index) => {
    const url = String(result.url || '').trim();
    if (!/^https?:\/\//i.test(url) || url.length > 2048) return [];
    const query = String(result.query || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return [{
      ref: `web-source-${index + 1}`,
      url,
      title: String(result.title || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      content: String(result.content || '').trim().slice(0, 1200),
      ...(query ? { query } : {}),
    }];
  });
}

export function createTopicDecisionToolRegistry(
  env: RuntimeAgentEnv,
  library?: Parameters<typeof mountLibraryTools>[1] | false,
  topicContext?: Parameters<typeof registerTopicContextTool>[2],
): ToolRegistry {
  const registry = registerPublishedArticleTools(new ToolRegistry().register({
    name: 'topic_search_web', replaySafety: 'repeatable',
    version: 1,
    description: [
      'Search the public web for one small, decision-blocking fact gap. This is not deep research, and it cannot prove search volume, keyword difficulty, or commercial value.',
      'Set country to the target market when relevant.',
      'Returns an array of results, each `{ url, title, content, query? }`. The `url` field is the citation key: when you cite one of these results as evidence, `evidence[].ref` must select its ref handle; the system resolves its saved URL.',
    ].join(' '),
    capability: 'external',
    inputSchema: topicSearchWebInputSchema,
    outputSchema: z.array(z.object({
      ref: z.string().optional(),
      url: z.string().url().max(2048),
      title: z.string().max(300),
      content: z.string().max(1200),
      query: z.string().max(300).optional(),
    })).max(MAX_TOPIC_WEB_RESULTS),
    timeoutMs: 60_000,
    retryable: true,
    approval: 'never',
    preserveOutputSize: true,
    execute: async (input) => normalizeTopicWebEvidence(await searchWeb({
      apiKey: env.FIRECRAWL_API_KEY || '',
      queries: input.queries, country: input.country,
    })),
  }), env);
  registerTopicContextTool(registry, env.DB as unknown as D1Database, topicContext);
  return library === false ? registry : mountLibraryTools(registry, library || { db: env.DB as unknown as D1Database, task: undefined!, operation: undefined!, locales: [], sets: ['read', 'topicLinks'] });
}
