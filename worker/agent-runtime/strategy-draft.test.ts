import { describe, expect, it } from 'vitest';
import {
  appendKeywords,
  assertKeywordBatchIsNew,
  emptyStrategyDraft,
  hasBlueprint,
  pendingClusterKeys,
  renderStrategyDraftOutline,
  strategyBlueprintOf,
  strategyDraftIdentity,
  strategyDraftSectionsOf,
  type StrategyDraftContent,
} from './strategy-draft';
import { classifyRuntimeModelFailure } from './model-errors';
import { assembleStrategyResearchResult, type StrategyBlueprint, type StrategyKeyword } from '../lib/research/ingest';

function keyword(term: string, clusterKey = 'c1'): StrategyKeyword {
  return {
    term, locale: 'pt-BR', cluster_key: clusterKey,
    intent: 'informational', journey_stage: 'problem', serp_shape: 'guides',
    recommended_page_type: 'blog', business_relevance: 'high', conversion_route: 'trial',
    priority_band: 'high', priority_rationale: 'impression: shallow incumbents',
    coverage_status: 'uncovered', decision: 'include', existing_url: '',
    evidence_summary: 'observed', source_urls: [],
  };
}

function blueprint(): StrategyBlueprint {
  return {
    change_summary: 'v1', research_scope_summary: 'BR market', executive_strategy: 'x',
    search_landscape: 'x', selected_playbooks: 'x', site_architecture: 'x',
    internal_linking: 'clusters link to their hub', roadmap: 'x', measurement: 'x',
    risks_unknowns: 'x', evidence_notes: 'x',
    territories: [{
      key: 't1', name: 'Scenario task', priority_band: 'high', status: 'active',
      audience_summary: 'a', search_job_summary: 'b', business_goal: 'c', conversion_goal: 'd', summary: 'e',
    }],
    clusters: [
      { key: 'c1', territory_key: 't1', name: 'Email writing', priority_band: 'high', status: 'active', strategic_role: 'task', recommended_hub: '/hub', conversion_goal: 'trial', summary: 's' },
      { key: 'c2', territory_key: 't1', name: 'Message reply', priority_band: 'medium', status: 'active', strategic_role: 'task', recommended_hub: '/hub', conversion_goal: 'trial', summary: 's' },
    ],
  };
}

function draftWithBlueprint(): StrategyDraftContent {
  const source = blueprint();
  return {
    ...emptyStrategyDraft('pt-BR'),
    territories: source.territories,
    clusters: source.clusters,
    sections: strategyDraftSectionsOf(source),
  };
}

describe('strategy working draft', () => {
  it('binds the draft to the continuation chain, not to one Run', () => {
    // A successor inherits the work; a genuinely new research task does not.
    const identity = strategyDraftIdentity({
      workspace_id: 'w1', site_id: 's1', agent_instance_id: 'strategy:ja-JP', root_run_id: 'root-1', id: 'run-2',
    });
    expect(identity).toEqual({
      workspaceId: 'w1', siteId: 's1', agentId: 'strategy_research',
      instanceId: 'strategy:ja-JP', lineageId: 'root-1',
    });
    // The first Run of a chain is its own root.
    expect(strategyDraftIdentity({
      workspace_id: 'w1', site_id: 's1', agent_instance_id: 'strategy:ja-JP', root_run_id: '', id: 'run-1',
    }).lineageId).toBe('run-1');
  });

  it('knows which stages are already done', () => {
    const empty = emptyStrategyDraft('pt-BR');
    expect(hasBlueprint(empty)).toBe(false);
    const withBlueprint = draftWithBlueprint();
    expect(hasBlueprint(withBlueprint)).toBe(true);
    // A successor must only redo the clusters that still have no keywords.
    expect(pendingClusterKeys(withBlueprint, ['c1', 'c2'])).toEqual(['c1', 'c2']);
    const partly = appendKeywords(withBlueprint, [keyword('escrever email', 'c1')]);
    expect(pendingClusterKeys(partly, ['c1', 'c2'])).toEqual(['c2']);
  });

  it('rejects a batch that repeats a keyword another batch already wrote', () => {
    // The reason batches needed a shared draft: they used to be blind to each
    // other and the duplicate was silently dropped at the very end.
    const draft = appendKeywords(draftWithBlueprint(), [keyword('escrever email', 'c1')]);
    expect(() => assertKeywordBatchIsNew(draft, [keyword('escrever email', 'c2')])).toThrow(/already exist/);
    expect(() => assertKeywordBatchIsNew(draft, [keyword('responder mensagem', 'c2')])).not.toThrow();
  });

  it('rejects a batch that repeats itself', () => {
    const draft = draftWithBlueprint();
    expect(() => assertKeywordBatchIsNew(draft, [
      keyword('escrever email', 'c1'), keyword('escrever email', 'c2'),
    ])).toThrow(/position 1/);
  });

  it('treats the same term in a different language as a different keyword', () => {
    const draft = appendKeywords(draftWithBlueprint(), [keyword('escrever email', 'c1')]);
    expect(() => assertKeywordBatchIsNew(draft, [keyword('escrever email', 'c2')])).toThrow();
  });

  it('classifies a duplicate rejection as repairable, even for transport-sounding keywords', () => {
    // Failure classification reads message text. A keyword like `connection
    // timeout` quoted inside its own rejection used to make that rejection look
    // like a provider failure, which the loop rethrows instead of repairing —
    // so the message names positions and never the term.
    const draft = appendKeywords(draftWithBlueprint(), [keyword('connection timeout no gmail', 'c1')]);
    let thrown: unknown;
    try {
      assertKeywordBatchIsNew(draft, [keyword('connection timeout no gmail', 'c2')]);
    } catch (error) { thrown = error; }
    expect(classifyRuntimeModelFailure(thrown).kind).toBe('invalid_output');
    expect(String((thrown as Error).message)).not.toContain('connection timeout no gmail');
  });

  it('shows structure and written terms, not the keyword map', () => {
    // The outline must stay short as the draft grows; that is the property that
    // lets an Agent keep producing without crowding out its own context.
    const draft = appendKeywords(draftWithBlueprint(), [keyword('escrever email', 'c1')]);
    const outline = renderStrategyDraftOutline(draft);
    expect(outline).toContain('c1 — Email writing');
    expect(outline).toContain('1 keywords written');
    expect(outline).toContain('c2 — Message reply');
    expect(outline).toContain('no keywords yet');
    expect(outline).toContain('escrever email → c1');
    // Per-keyword detail stays out.
    expect(outline).not.toContain('conversion_route');
    expect(outline).not.toContain('impression: shallow incumbents');
    expect(renderStrategyDraftOutline(emptyStrategyDraft('pt-BR'))).toContain('empty');
  });

  it('rebuilds the exact blueprint a predecessor Run persisted', () => {
    // A successor resuming after the blueprint stage must read the same skeleton,
    // or it renumbers clusters its predecessor already filled with keywords.
    const source = blueprint();
    expect(strategyBlueprintOf(draftWithBlueprint())).toEqual(source);
  });

  it('produces the same strategy documents as passing the blueprint in memory', () => {
    // Equivalence guard for the refactor: routing the artifact through a draft
    // must not change what gets published.
    const source = blueprint();
    const keywords = [keyword('escrever email', 'c1'), keyword('responder mensagem', 'c2')];
    const viaMemory = assembleStrategyResearchResult(source, keywords, [], 'pt-BR');
    const viaDraft = assembleStrategyResearchResult(
      strategyBlueprintOf(appendKeywords(draftWithBlueprint(), keywords)),
      appendKeywords(draftWithBlueprint(), keywords).keywords,
      [], 'pt-BR',
    );
    expect(viaDraft).toEqual(viaMemory);
  });
});
