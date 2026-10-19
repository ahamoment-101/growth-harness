import { describe, expect, it } from 'vitest';
import { aggregateLanguageTopicDecisions, normalizeTopicDecisionBranches, topicDecisionOutputSchema, type TopicDecisionOutput } from './topic-decision-contract';
import {
  normalizeTopicDecisionAgainstContext,
  topicDecisionSubmissionFeedback,
  validateTopicDecisionAgainstContext,
} from './topic-decision-validation';

const item = {
  strategy_keyword_id: 'sk-1', keyword_id: 'kw-1', topic_key: 'best-notes-app',
  title_direction: 'Best note apps for research teams', primary_keyword: 'best notes app',
  content_type: 'COMPARISON' as const, locale: 'en', search_intent: 'compare products',
  group_role: 'commercial comparison', rationale: 'High-priority strategic keyword',
  hypothesis: 'Qualified comparison traffic will visit the product page',
  evidence: [{ source_type: 'strategy' as const, ref: 'sk-1', summary: 'Included in active strategy' }],
  relationship_to_existing: 'No exact keyword match', risk: 'Competitive SERP',
};

const output: TopicDecisionOutput = {
  decision_type: 'topic_group', rationale: 'Test the comparison cluster first', research_request: null, defer: null,
  group: {
    goal: 'Test commercial comparison demand', hypothesis: 'Comparison pages can create qualified visits',
    expected_signals: ['qualified impressions'], risks: ['competitive SERP'], unknowns: ['conversion lag'],
    previous_group_relationship: 'First group', items: [item],
  },
};

const context = {
  active_strategy: { keywords: [{ strategy_keyword_id: 'sk-1', keyword_id: 'kw-1', term: 'best notes app', locale: 'en', coverage_status: 'partial' }] },
  business_constraints: { modules: [{ key: 'brand' }] },
  run_constraints: { requested_count: 3, source_locale: 'en', locales: ['en', 'fr'] },
  content_inventory: { topics: [] },
};

describe('topic decision contract', () => {
  it('accepts one evidence-backed group and the explicit needs-research alternative', () => {
    expect(validateTopicDecisionAgainstContext(output, context)).toEqual(output);
    expect(topicDecisionOutputSchema.parse({
      decision_type: 'needs_research', rationale: 'The strategic evidence is incomplete', group: null,
      defer: null,
      research_request: {
        gap: 'SERP intent is unclear', why_blocking: 'Page type would change', known: ['keyword is strategic'],
        unknown: ['dominant intent'], requested_evidence: ['SERP sample'], reconsider_after: 'after intent research',
      },
    }).decision_type).toBe('needs_research');
    expect(topicDecisionOutputSchema.parse({
      decision_type: 'defer', rationale: 'Production feedback is not ready', group: null, research_request: null,
      defer: {
        reason: 'The current group still has unresolved execution failures', blockers: ['six failed article tasks'],
        recommended_action: 'Retry the failed article tasks', resume_when: 'the group reaches human review',
      },
    }).decision_type).toBe('defer');
  });

  it('deterministically keeps only the branch selected by decision_type', () => {
    expect(topicDecisionOutputSchema.parse(normalizeTopicDecisionBranches({
      ...output,
      research_request: { gap: 'non-blocking', why_blocking: 'none', known: [], unknown: ['x'], requested_evidence: ['y'], reconsider_after: 'later' },
    }))).toEqual(output);
  });

  it('preserves successful language Topics when another language defers', () => {
    const deferred: TopicDecisionOutput = {
      decision_type: 'defer', rationale: 'Wait for market evidence', group: null, research_request: null,
      defer: {
        reason: 'Local evidence is incomplete', blockers: ['market evidence'],
        recommended_action: 'Research the local SERP', resume_when: 'local evidence is ready',
      },
    };
    const combined = aggregateLanguageTopicDecisions([
      { locale: 'en', output },
      { locale: 'ja', output: deferred },
    ]);
    expect(combined.decision_type).toBe('topic_group');
    expect(combined.group?.items).toEqual([item]);
    expect(combined.rationale).toContain('[en]');
  });

  it('rejects invented keywords, duplicates, locale drift, existing exact keywords, and fabricated Web citations', () => {
    const mutate = (patch: Record<string, unknown>): TopicDecisionOutput => (
      { ...output, group: { ...output.group!, items: [{ ...item, ...patch }] } } as TopicDecisionOutput
    );
    expect(() => validateTopicDecisionAgainstContext(mutate({ strategy_keyword_id: 'invented' }), context)).toThrow(/unknown strategy keyword/);
    expect(() => validateTopicDecisionAgainstContext({ ...output, group: { ...output.group!, items: [item, item] } }, { ...context, run_constraints: { requested_count: 3, locales: ['en'] } })).toThrow(/repeats topic key/);
    expect(() => validateTopicDecisionAgainstContext(mutate({ locale: 'de' }), context)).toThrow(/unrequested locale/);
    expect(() => validateTopicDecisionAgainstContext(mutate({ locale: 'fr' }), {
      ...context,
      active_strategy: { keywords: [{ strategy_keyword_id: 'sk-1', keyword_id: 'kw-1', term: 'best notes app', locale: 'fr' }] },
    })).toThrow(/site source locale/);
    expect(() => validateTopicDecisionAgainstContext(output, { ...context, content_inventory: { topics: [{ primary_keyword: 'Best Notes App' }] } })).not.toThrow();
    expect(() => validateTopicDecisionAgainstContext(mutate({ evidence: [{ source_type: 'web', ref: 'https://invented.example', summary: 'claim' }] }), context, [])).toThrow(/was not returned/);
    expect(() => validateTopicDecisionAgainstContext(mutate({ evidence: [{ source_type: 'web', ref: 'invented.internal.path', summary: 'claim' }] }), context, [])).toThrow(/was not returned/);
    expect(() => validateTopicDecisionAgainstContext(output, {
      ...context,
      active_strategy: { keywords: [{ ...context.active_strategy.keywords[0], coverage_status: 'covered' }] },
    })).not.toThrow();
  });

  it('binds redundant identities but never guesses evidence provenance', () => {
    const malformed = {
      ...output,
      group: {
        ...output.group!,
        items: [{
          ...item,
          keyword_id: 'copied-from-another-item',
          evidence: [
            { source_type: 'web' as const, ref: 'active_strategy.strategy_doc', summary: 'strategy direction' },
            { source_type: 'web' as const, ref: 'keyword_map.cluster_notes', summary: 'keyword cluster' },
            { source_type: 'web' as const, ref: 'brand.prohibited_claims', summary: 'business boundary' },
          ],
        }],
      },
    };
    const normalized = normalizeTopicDecisionAgainstContext(malformed, context);
    expect(normalized.group?.items[0].keyword_id).toBe('kw-1');
    expect(normalized.group?.items[0].evidence.map((entry) => entry.source_type)).toEqual([
      'web', 'web', 'web',
    ]);
    expect(() => validateTopicDecisionAgainstContext(normalized, context)).toThrow(/was not returned/);
  });

  it('returns domain validation as repairable feedback while preserving the candidate', () => {
    const invalid = {
      ...output,
      group: { ...output.group!, items: [{ ...item, strategy_keyword_id: 'invented' }] },
    };
    const rejected = topicDecisionSubmissionFeedback({ decision: invalid, context, webEvidence: [] });
    expect(rejected.feedback).toMatchObject({
      accepted: false,
      // Reference integrity is repairable in place, so it is reported as format
      // and the guidance tells the model to fix the field, not rethink.
      issues: [{ code: 'unknown_strategy_keyword', severity: 'format' }],
    });
    expect(rejected.feedback.guidance).toContain('Repair only the fields named below');
    expect(rejected.feedback.issues[0].message).toMatch(/unknown strategy keyword/);
    expect(invalid.group.items[0].strategy_keyword_id).toBe('invented');
    expect(topicDecisionSubmissionFeedback({ decision: output, context, webEvidence: [] }).feedback.accepted).toBe(true);
  });
});
