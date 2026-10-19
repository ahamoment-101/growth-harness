import { describe, expect, it } from 'vitest';
import {
  assembleStrategyResearchResult,
  chunkClusterKeys,
  normalizeStrategyResult,
  renderKeywordMapMarkdown,
  strategyResearchPrompt,
  strategyKeywordBatchPrompt,
  strategyResearchQueries,
  strategyResearchSiteProjection,
  type StrategyBlueprint,
  type StrategyResearchResult,
} from './ingest';
import { EMPTY_SITE_GSC, EMPTY_SITE_RESEARCH, type Site } from '../../types';
import { researchConfigOf } from './config';

function site(): Site {
  return {
    id: 's1',
    workspace_id: 'primary-workspace',
    name: 'Example Product',
    domain: 'blog.example.com',
    root_domain: 'example.com',
    ingest_url: '',
    ingest_secret: '',
    secret_header: 'x-ingest-secret',
    locales_json: '["en"]',
    translate_locales_json: '[]',
    webhook_fields_json: '[]',
    webhook_mode: 'group',
    hub_path: '/write-english',
    product_origin: '',
    locale_policy_json: '',
    source_locale: 'en',
    hub_urls_json: '{}',
    seo_identity_json: '{}',
    blog_layout: 'magazine',
    model: 'x',
    min_words: 400,
    created_at: '2026-01-01',
    domain_status: 'unverified',
    domain_error: '',
    domain_checked_at: '',
    ...EMPTY_SITE_GSC,
    ...EMPTY_SITE_RESEARCH,
  };
}

function result(): StrategyResearchResult {
  return {
    change_summary: 'Establish the first version of the strategy',
    research_scope_summary: 'US/en',
    seo_strategy_md: '# SEO Strategy',
    research_notes_md: '# Research Evidence',
    territories: [{
      key: 'team-localization', name: 'Team localization', priority_band: 'high', status: 'active',
      audience_summary: 'Cross-border team', search_job_summary: 'Looking for a collaboration solution', business_goal: 'Sign up', conversion_goal: 'Free trial', summary: 'Build a collaboration advantage',
    }],
    clusters: [{
      key: 'collaborative-translation', territory_key: 'team-localization', name: 'Collaborative translation', priority_band: 'high',
      status: 'active', strategic_role: 'Business need', recommended_hub: '/team-localization', conversion_goal: 'Free trial', summary: 'Cover collaboration searches',
    }],
    keywords: [{
      term: 'collaborative translation platform', locale: 'en', cluster_key: 'collaborative-translation',
      intent: 'commercial', journey_stage: 'comparison', serp_shape: 'solution pages', recommended_page_type: 'solution',
      business_relevance: 'Core capabilities', conversion_route: 'Free trial', priority_band: 'high', priority_rationale: 'Strong business relevance',
      coverage_status: 'uncovered', decision: 'include', existing_url: '', evidence_summary: 'The SERP shows a clear solution-seeking need',
      source_urls: ['https://example.com/source'],
    }],
  };
}

describe('strategy research prompt', () => {
  it('projects only non-secret site fields into durable synthesis inputs', () => {
    const sensitiveSite = {
      ...site(),
      ingest_secret: 'ingest-secret',
      gsc_refresh_token_cipher: 'encrypted-refresh-token',
      gsc_verification_meta_token: 'verification-token',
    };
    const projected = strategyResearchSiteProjection(sensitiveSite);
    expect(projected).toEqual({
      name: 'Example Product',
      domain: 'blog.example.com',
      root_domain: 'example.com',
      source_locale: 'en',
      locale_brief: expect.objectContaining({
        target_locale: 'en',
        target_language: 'English',
        strategy_mode: 'independent_market_strategy',
      }),
    });
    expect(JSON.stringify(projected)).not.toContain('secret');
    expect(JSON.stringify(projected)).not.toContain('token');
  });

  it('makes business facts authoritative and enables expert web research', () => {
    const { system, user } = strategyResearchPrompt({
      site: strategyResearchSiteProjection(site()),
      config: researchConfigOf(site()),
      competitors: [],
      pages: [{ id: 'p', competitor_id: 'c', url: 'https://competitor.example/x', title: '', keyword_hint: 'competitor lifetime', content_type: '', fetched_at: '' }],
      autocomplete: [{ seed: 'competitor alternative', suggestions: ['competitor alternative 2026'], error: '' }],
      gsc: [{ query: 'competitor vs example product', clicks: 2, impressions: 80, position: 12 }],
      asOf: { competitors: '2026-08-01', gsc: 'latest snapshot' },
      businessContext: '## Product Information\nHelp teams manage multilingual content.',
      previousStrategyContext: '',
      deepResearchReports: [{
        question: 'Which strategic wedge is underserved?',
        content: 'Deep research found an underserved workflow-specific segment.',
        sources: [{ title: 'Source', url: 'https://example.com/deep' }],
      }],
    });
    expect(system).toContain('Strategy Research Agent');
    expect(system).toContain('supplied web evidence proactively');
    expect(system).toContain('never rewrite');
    expect(system).toContain('immutable identity');
    expect(user).toContain('CONFIRMED BUSINESS FOUNDATION');
    expect(user).toContain('Target locale: en');
    expect(user).toContain('English language market (no country or region specified)');
    expect(user).toContain('https://competitor.example/x');
    expect(user).toContain('pos=12.0');
    expect(user).toContain('DEEP RESEARCH');
    expect(user).toContain('underserved workflow-specific segment');
  });

  it('makes positioning the starting point and real search results the page-type authority', () => {
    // These four instructions are the research method, not wording preference.
    // Without the first, the Agent produces category terms every competitor also
    // targets; without the second, `serp_shape` and `recommended_page_type` are
    // guesses that the whole downstream article plan is then built on.
    const { system } = strategyResearchPrompt({
      site: strategyResearchSiteProjection(site()),
      config: researchConfigOf(site()), competitors: [], pages: [], autocomplete: [], gsc: [],
      asOf: { competitors: '', gsc: '' }, businessContext: '', previousStrategyContext: '',
    });
    expect(system).toContain('Anchor the strategy in what the product claims');
    expect(system).toContain('Derive this site’s own families of search intent');
    expect(system).toContain('Decide page types from what actually ranks');
    expect(system).toContain('Plan internal linking as part of the strategy');
    // A qualitative competitive read is useful; a fabricated number is not.
    expect(system).toContain('Never state a number as if it were measured');
  });

  it('shows a keyword batch what the other batches already wrote', () => {
    // Batches used to be blind to each other, so two clusters could produce the
    // same keyword and the duplicate was silently dropped at the very end.
    const base = result();
    const { system, user } = strategyKeywordBatchPrompt(
      {
        env: {} as never, site: strategyResearchSiteProjection(site()),
        config: researchConfigOf(site()), competitors: [], pages: [], autocomplete: [], gsc: [],
        asOf: { competitors: '', gsc: '' }, businessContext: '', previousStrategyContext: '',
        deepResearchReports: [],
      },
      [], {
        change_summary: '', research_scope_summary: '', executive_strategy: '', search_landscape: '',
        selected_playbooks: '', site_architecture: '', internal_linking: '', roadmap: '',
        measurement: '', risks_unknowns: '', evidence_notes: '',
        territories: base.territories, clusters: base.clusters,
      }, [base.clusters[0].key],
      'STRATEGY DRAFT (locale en)\nKeywords already written (1):\n  translation platform → collaborative-translation',
    );
    expect(user).toContain('Keywords already written');
    expect(user).toContain('translation platform → collaborative-translation');
    expect(system).toContain('Never repeat one of them');
    // With no draft yet, the batch is told so explicitly rather than shown nothing.
    const { user: firstBatch } = strategyKeywordBatchPrompt(
      {
        env: {} as never, site: strategyResearchSiteProjection(site()),
        config: researchConfigOf(site()), competitors: [], pages: [], autocomplete: [], gsc: [],
        asOf: { competitors: '', gsc: '' }, businessContext: '', previousStrategyContext: '',
        deepResearchReports: [],
      },
      [], {
        change_summary: '', research_scope_summary: '', executive_strategy: '', search_landscape: '',
        selected_playbooks: '', site_architecture: '', internal_linking: '', roadmap: '',
        measurement: '', risks_unknowns: '', evidence_notes: '',
        territories: base.territories, clusters: base.clusters,
      }, [base.clusters[0].key],
    );
    expect(firstBatch).toContain('STRATEGY DRAFT: empty');
  });

  it('carries the internal-link plan into the published strategy document', () => {
    // Internal linking is how a cluster reads as one topic. Nothing downstream
    // was deciding it, so it has to survive into the document the article agents
    // and the next strategy version actually read.
    const base = result();
    const assembled = assembleStrategyResearchResult({
      change_summary: base.change_summary, research_scope_summary: base.research_scope_summary,
      executive_strategy: 'x', search_landscape: 'x', selected_playbooks: 'x', site_architecture: 'x',
      internal_linking: 'Link the keyword cluster pages to each other using descriptive anchor text.',
      roadmap: 'x', measurement: 'x', risks_unknowns: 'x', evidence_notes: 'x',
      territories: base.territories, clusters: base.clusters,
    }, base.keywords, [], 'en');
    expect(assembled.seo_strategy_md).toContain('## Internal Linking Plan');
    expect(assembled.seo_strategy_md).toContain('descriptive anchor text');
  });

  it('tells the Agent to use the wording the target market actually types', () => {
    // Correct language is not the same as local. The market searches one specific
    // synonym, and picking the other by language intuition loses the query.
    const { user } = strategyResearchPrompt({
      site: strategyResearchSiteProjection({ ...site(), source_locale: 'pt-BR' }),
      config: researchConfigOf(site()), competitors: [], pages: [], autocomplete: [], gsc: [],
      asOf: { competitors: '', gsc: '' }, businessContext: '', previousStrategyContext: '',
    });
    expect(user).toContain('Word-choice habits');
    expect(user).toContain('users would actually type');
  });

  it('builds an independent Brazilian Portuguese market brief without leaking configured source locales', () => {
    const projected = strategyResearchSiteProjection({ ...site(), source_locale: 'pt-BR', locales_json: '["en"]' });
    const { user } = strategyResearchPrompt({
      site: projected,
      config: researchConfigOf(site()), competitors: [], pages: [], autocomplete: [], gsc: [],
      asOf: { competitors: '', gsc: '' }, businessContext: 'produto confirmado', previousStrategyContext: '',
    });
    expect(user).toContain('Target locale: pt-BR');
    expect(user).toContain('Brazil market');
    expect(user).toContain('Portuguese');
    expect(user).not.toContain('Configured locales: ["en"]');
  });

  it('creates bounded deterministic Search provider queries from configured SEO evidence', () => {
    expect(strategyResearchQueries({
      site: site(),
      config: { ...researchConfigOf(site()), seed_terms: ['translation tool', 'website localization'] },
      gsc: [{ query: 'translation tool alternatives' }, { query: 'website localization platform' }],
    })).toEqual([
      'translation tool', 'website localization', 'translation tool alternatives', 'website localization platform',
      'translation tool alternatives competitors', 'translation tool use cases', 'translation tool SEO strategy',
    ]);
  });

  it('keeps structured keyword identity aligned with the rendered Markdown', () => {
    const normalized = normalizeStrategyResult(result(), 'en');
    const markdown = renderKeywordMapMarkdown(normalized, 2, '2026-08-22T00:00:00Z');
    expect(normalized.keywords[0].cluster_key).toBe('collaborative-translation');
    expect(markdown).toContain('strategy_version: 2');
    expect(markdown).toContain('collaborative translation platform');
    expect(markdown).toContain('Team localization');
  });

  it('stamps keyword locale from the Run identity instead of trusting model output', () => {
    const wrongLocale = result();
    wrongLocale.keywords[0].locale = 'en';
    expect(normalizeStrategyResult(wrongLocale, 'pt-BR').keywords[0].locale).toBe('pt-BR');
  });

  it('batches clusters and assembles all three version documents without another large model call', () => {
    const base = result();
    const blueprint: StrategyBlueprint = {
      change_summary: base.change_summary,
      research_scope_summary: base.research_scope_summary,
      executive_strategy: 'Focus on search tasks with high business relevance.',
      search_landscape: 'The market shows both tool and collaboration solution needs.',
      selected_playbooks: 'Solution pages and comparison pages work together.',
      site_architecture: 'Topic hub linking to keyword cluster pages.',
      internal_linking: 'Cluster pages interlink with descriptive anchor text; the topic hub page funnels traffic to the new pages.',
      roadmap: 'Cover high-priority clusters first.',
      measurement: 'Monitor effective impressions and conversions.',
      risks_unknowns: 'Reliable search volume data is missing.',
      evidence_notes: 'Sources support that demand exists, but commercial value still needs validation.',
      territories: base.territories,
      clusters: base.clusters,
    };
    expect(chunkClusterKeys([...base.clusters, ...base.clusters.map((cluster, index) => ({ ...cluster, key: `cluster-${index + 2}` }))], 1))
      .toEqual([['collaborative-translation'], ['cluster-2']]);
    const assembled = assembleStrategyResearchResult(blueprint, base.keywords, [{
      url: 'https://example.com/source', title: 'Source', content: 'Evidence', query: 'translation platform',
    }], 'en');
    expect(assembled.seo_strategy_md).toContain('## Chosen Play');
    expect(assembled.research_notes_md).toContain('translation platform');
    expect(renderKeywordMapMarkdown(assembled, 1, '2026-08-23')).toContain('collaborative translation platform');
  });
});
