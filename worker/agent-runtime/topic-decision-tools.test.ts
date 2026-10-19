import { describe, expect, it } from 'vitest';
import { agentDefinition } from './definitions';
import { createTopicDecisionToolRegistry, normalizeTopicWebEvidence } from './topic-decision-tools';

describe('topic decision tool policy', () => {
  it('exposes published coverage and one research action; decisions are drafted by the conversation tools', () => {
    const definition = agentDefinition('topic_decision');
    const registry = createTopicDecisionToolRegistry({ FIRECRAWL_API_KEY: 'test' } as never);
    expect(definition.tools).toEqual(expect.arrayContaining(['open_keyword_library', 'read_library_entry', 'relate_library_topic', 'read_published_articles', 'topic_search_web']));
    expect(definition.tools).not.toContain('submit_topic_decision');
    expect(definition.injectedTool).toBeNull();
    expect(() => registry.resolve(definition, 'topic_search_web')).not.toThrow();
    expect(() => registry.resolve(definition, 'read_published_articles')).not.toThrow();
    expect(() => registry.resolve(definition, 'deep_research')).toThrow(/not allowed/);
  });

  it('caps simple Web Search at three related queries before execution', async () => {
    const definition = agentDefinition('topic_decision');
    const registry = createTopicDecisionToolRegistry({ FIRECRAWL_API_KEY: 'test' } as never);
    await expect(registry.execute(definition, 'topic_search_web', {
      queries: ['one', 'two', 'three', 'four'], judgment_summary: 'gap',
    }, { runId: 'r', workspaceId: 'w', siteId: 's', idempotencyKey: 'r:search' })).rejects.toThrow();
  });

  it('bounds Web evidence before durable replay and persistence', () => {
    const results = normalizeTopicWebEvidence(Array.from({ length: 20 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: 't'.repeat(600),
      content: 'c'.repeat(2400),
      query: 'q'.repeat(600),
    })));
    expect(results).toHaveLength(12);
    expect(results[0]).toMatchObject({
      title: 't'.repeat(300),
      content: 'c'.repeat(1200),
      query: 'q'.repeat(300),
    });
    expect(JSON.stringify(results).length).toBeLessThan(32_000);
  });
});

