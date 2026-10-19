import { expect, it, vi } from 'vitest';
import { loadArticleProductionContext, publicationQa, validateArticleSubmission, type ArticleTask } from './content-production';
import type { ArticleBundle } from './article-production-tools';
import type { AgentRun } from './protocol';

vi.mock('../lib/business', () => ({ listBusinessModules: async () => [], buildBusinessContext: () => '' }));
vi.mock('../lib/research/strategy-store', () => ({ strategyVersionContext: async () => 'Saved strategy' }));

const site = { id: 'site', domain: 'blog.example.com', domain_status: 'live', hub_path: '/', product_origin: 'https://example.com', source_locale: 'en' };
const published = { id: 'older-guide', versions_json: JSON.stringify([{ locale: 'en', title: 'Older guide', slug: 'older-guide', excerpt: 'Guide', content: 'Guide' }]) };

// One store answers both gates, the way D1 would for the same site and group.
const db = {
  prepare: (sql: string) => ({
    bind: () => ({
      first: async () => ({ job_id: 'job', decision_item_id: 'item', decision_group_id: 'decision', source_locale: 'en', locale: 'en',
        translate_locales_json: '[]', strategy_version_id: 'strategy', previous_artifact_id: '', title_hint: 'Comparison', evidence_json: '[]' }),
      all: async () => ({ results: sql.includes("status = 'published'") ? [published]
        : sql.includes('i.title_direction') ? [{ job_id: 'sibling-job', title_direction: 'Sibling', primary_keyword: 'sibling', locale: 'en' }]
        : sql.startsWith('select id from jobs where production_group_id') ? [{ id: 'sibling-job' }]
        : [] }),
    }),
  }),
} as unknown as D1Database;

const linkIssues = (issues: Array<{ code: string }>) => issues.map((issue) => issue.code)
  .filter((code) => code.endsWith('_unknown_article_ref') || code.endsWith('_dead_internal_link')).sort();

async function bothGates(content: string) {
  const run = { id: 'author', site_id: 'site', summary_json: JSON.stringify({ group_id: 'group', job_id: 'job' }) } as AgentRun;
  const [context] = await loadArticleProductionContext(db, site, run);
  const versions = [{ locale: 'en', title: 'Comparison', slug: 'comparison', excerpt: 'Compare', content }];
  const bundle = { versions, seo_contract: { search_intent: 'Compare', reader_value: 'Choose', direct_answer: 'It depends',
    primary_keyword: 'comparison', supporting_terms: [], geo_summary: 'Compare' } } as unknown as ArticleBundle;
  const submission = validateArticleSubmission(context.value as ArticleTask, bundle);
  const approval = await publicationQa(db, site, { id: 'job', site_id: 'site', production_group_id: 'group' }, versions, ['en']);
  return { submission: linkIssues(submission.issues), approval: linkIssues(approval.issues) };
}

it('approves every internal link the writer was allowed to submit', async () => {
  const gates = await bothGates('Read [the guide](article:older-guide), '
    + '[its live URL](https://blog.example.com/en/blog/older-guide) and [the sibling](article:sibling-job).');
  expect(gates).toEqual({ submission: [], approval: [] });
});

it('rejects an invented article reference or blog URL at both gates alike', async () => {
  const gates = await bothGates('See [a guess](article:missing-job) and [a composed URL](/en/blog/made-up-slug).');
  expect(gates.submission).toEqual(['en_dead_internal_link', 'en_unknown_article_ref']);
  expect(gates.approval).toEqual(gates.submission);
});
