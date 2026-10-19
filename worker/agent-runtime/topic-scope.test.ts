import { expect, it } from 'vitest';
import { scopedTopicSummary, topicInstance, topicScope } from './topic-scope';
import { loadTopicDecisionContext } from './topic-decision-context';
it('binds exactly one normalized language and creates distinct execution identities', async () => {
  const en = scopedTopicSummary({ locale: 'en', group_size: 2 });
  const pt = scopedTopicSummary({ locale: 'pt-br' });
  expect(en.scope).toEqual({ locale: 'en' });
  expect(pt.locales).toEqual(['pt-BR']);
  expect(topicInstance(en.scope)).not.toBe(topicInstance(pt.scope));
  expect(topicInstance(en.scope)).toBe(topicInstance({ locale: 'en' }));
  expect(() => scopedTopicSummary({ locales: ['en', 'pt-BR'] })).toThrow();
  expect(topicScope(JSON.stringify(en))).toEqual(en.scope);
  // Initialization has no database reads: business reading remains in Agent tools.
  const sources = await loadTopicDecisionContext({ prepare: () => { throw new Error('Unexpected preload'); } } as never, {} as never, { id: 'r', summary_json: JSON.stringify(en), created_at: 'now' } as never);
  expect(sources.find(source => source.sourceId === 'run_constraints')!.value).toMatchObject({ locales: ['en'], keyword_source: 'keyword_library_only' });
});

it('rejects a market dimension and rejects starting work outside project languages', async () => {
  expect(() => scopedTopicSummary({ scope: { locale: 'en', market: 'global' } })).toThrow();
  const { runtimeAgentModule } = await import('./agent-modules');
  const summary = scopedTopicSummary({ locale: 'fr' });
  await expect(runtimeAgentModule('topic_decision').validateStart!({} as never, {
    workspaceId: 'w', siteId: 's', agentId: 'topic_decision', trigger: 'manual', summary, instanceId: topicInstance(summary.scope),
  }, { source_locale: 'en', translate_locales_json: '["pt-BR"]' })).rejects.toThrow('languages enabled for the project');
});
