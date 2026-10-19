import { expect, it, vi } from 'vitest';
import { loadArticleProductionContext } from './content-production';
import type { AgentRun } from './protocol';

vi.mock('../lib/business', () => ({ listBusinessModules: async () => [], buildBusinessContext: () => '' }));
vi.mock('../lib/research/strategy-store', () => ({ strategyVersionContext: async () => 'Saved strategy' }));

it('delivers editorial guidance, review feedback and saved languages without adopting newer site languages', async () => {
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => sql.startsWith('select id,versions_json,seo_contract_json') ? ({
          id: 'candidate-1',
          versions_json: JSON.stringify([{ locale: 'en', title: 'A comparison', slug: 'comparison', excerpt: 'Compare', content: 'Preserve this [guide](article:older-guide).' }]),
          seo_contract_json: JSON.stringify({ internal_link_targets: [{ status: 'published', job_id: 'older-guide', locale: 'en', title: 'Older guide', href: 'article:older-guide', url: 'https://blog.example.com/en/blog/older-guide' }] }),
        }) : ({
          job_id: 'job', decision_item_id: 'item', decision_group_id: 'decision',
          source_locale: 'en', locale: 'en', translate_locales_json: '[]',
          strategy_version_id: 'strategy', previous_artifact_id: 'candidate-1',
          title_hint: 'A comparison', evidence_json: '[]',
        }),
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database;
  const run = {
    id: 'same-author-run', site_id: 'site',
    summary_json: JSON.stringify({ group_id: 'group', job_id: 'job', attempt: 2,
      editorial_brief: 'Preserve the useful comparison and clarify who should use each product.',
      parent_feedback: ['Support the pricing claim with current evidence.'],
    }),
  } as AgentRun;
  const [context] = await loadArticleProductionContext(db, { source_locale: 'fr', translate_locales_json: '["de"]' }, run);
  expect(context.value).toMatchObject({
    source_locale: 'en', locales: ['en'], attempt: 2, previous_artifact_id: 'candidate-1',
    editorial_brief: 'Preserve the useful comparison and clarify who should use each product.',
    parent_feedback: ['Support the pricing claim with current evidence.'],
    previous_candidate: { artifact_id: 'candidate-1', versions: [{ locale: 'en', content: 'Preserve this [guide](article:older-guide).' }] },
    published_articles: [{ job_id: 'older-guide', url: 'https://blog.example.com/en/blog/older-guide' }],
  });
});
