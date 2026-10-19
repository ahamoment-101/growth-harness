/**
 * The strategy Agent's own use of the shared working draft.
 *
 * Everything here is domain: the shape of a strategy in progress, what counts as
 * a stage already done, what the Agent is shown about it, and which keywords
 * conflict with which. The shared layer holds none of this — it stores an opaque
 * document for an identity, and this file decides what that document is.
 *
 * The draft's shape is deliberately the delivered artifact's shape. A separate
 * "draft format" would need a translation step on submit, and that step is where
 * fields quietly go missing.
 */
import type {
  StrategyBlueprint, StrategyCluster, StrategyKeyword, StrategyTerritory,
} from '../lib/research/ingest';
import { RuntimeValidationError } from './model-errors';
import type { WorkingDraftIdentity } from './working-draft';

/** The eleven prose fields of a strategy version, keyed as the blueprint names them. */
export type StrategyDraftSections = {
  change_summary: string;
  research_scope_summary: string;
  executive_strategy: string;
  search_landscape: string;
  selected_playbooks: string;
  site_architecture: string;
  internal_linking: string;
  roadmap: string;
  measurement: string;
  risks_unknowns: string;
  evidence_notes: string;
};

export type StrategyDraftContent = {
  kind: 'strategy_research';
  locale: string;
  territories: StrategyTerritory[];
  clusters: StrategyCluster[];
  keywords: StrategyKeyword[];
  sections: StrategyDraftSections | null;
};

export function emptyStrategyDraft(locale: string): StrategyDraftContent {
  return { kind: 'strategy_research', locale, territories: [], clusters: [], keywords: [], sections: null };
}

/**
 * The draft belongs to the continuation chain, not to one Run.
 *
 * `instanceId` already carries the locale, so two languages researched in
 * parallel never share a draft; `lineageId` is the root Run, so a successor
 * inherits the work while a newly started research task gets a clean sheet.
 */
export function strategyDraftIdentity(run: {
  workspace_id: string; site_id: string; agent_instance_id: string; root_run_id: string; id: string;
}): WorkingDraftIdentity {
  return {
    workspaceId: run.workspace_id,
    siteId: run.site_id,
    agentId: 'strategy_research',
    instanceId: run.agent_instance_id,
    lineageId: run.root_run_id || run.id,
  };
}

/** A blueprint is done once the skeleton and the prose both exist. */
export function hasBlueprint(draft: StrategyDraftContent): boolean {
  return Boolean(draft.sections) && draft.territories.length > 0 && draft.clusters.length > 0;
}

export function clusterKeysWithKeywords(draft: StrategyDraftContent): Set<string> {
  return new Set(draft.keywords.map((keyword) => keyword.cluster_key));
}

/**
 * Which of a batch's clusters still need keywords.
 *
 * Read from the draft rather than from a counter, because the answer has to
 * survive a Run boundary: a successor asking "what is left" is the whole reason
 * the draft outlives its Run.
 */
export function pendingClusterKeys(draft: StrategyDraftContent, clusterKeys: string[]): string[] {
  const covered = clusterKeysWithKeywords(draft);
  return clusterKeys.filter((key) => !covered.has(key));
}

function keywordIdentity(term: string): string {
  return `${term.trim().toLocaleLowerCase()}`;
}

/**
 * Rejects a batch that repeats work the draft already holds.
 *
 * This is the reason batches needed a shared draft at all: they used to be blind
 * to each other, so two clusters could produce the same keyword and the
 * duplicate was silently dropped at the very end — the batch had spent its slots
 * on nothing and no one could tell. Rejecting instead returns the reason to the
 * model, which spends a repair attempt rather than a whole batch.
 *
 * The message names positions, never the offending term. Failure classification
 * reads message text, and a keyword such as `connection timeout` quoted in its
 * own rejection would classify that rejection as a transport failure.
 */
export function assertKeywordBatchIsNew(
  draft: StrategyDraftContent,
  batch: StrategyKeyword[],
): StrategyKeyword[] {
  const existing = new Set(draft.keywords.map((keyword) => keywordIdentity(keyword.term)));
  const withinBatch = new Set<string>();
  const duplicates: number[] = [];
  batch.forEach((keyword, index) => {
    const identity = keywordIdentity(String(keyword.term || ''));
    if (existing.has(identity) || withinBatch.has(identity)) duplicates.push(index);
    withinBatch.add(identity);
  });
  if (duplicates.length) {
    throw new RuntimeValidationError(
      `Keywords at position ${duplicates.join(', ')} already exist in this strategy draft or repeat another keyword in the same batch. `
      + 'Replace them with distinct searches; the draft outline lists every keyword already written.',
    );
  }
  return batch;
}

/** Adds a batch, after checking it against everything already written. */
export function appendKeywords(
  draft: StrategyDraftContent,
  batch: StrategyKeyword[],
): StrategyDraftContent {
  return { ...draft, keywords: [...draft.keywords, ...assertKeywordBatchIsNew(draft, batch)] };
}

/**
 * What the model is shown about the draft.
 *
 * Structure only. Its length is governed by how many clusters exist, not by how
 * much has been written into them, which is the property that lets the Agent
 * keep producing without its own output crowding out its context.
 */
export function renderStrategyDraftOutline(draft: StrategyDraftContent): string {
  if (!draft.territories.length && !draft.clusters.length && !draft.sections) {
    return 'STRATEGY DRAFT: empty. Nothing has been written yet.';
  }
  const keywordsByCluster = new Map<string, number>();
  for (const keyword of draft.keywords) {
    keywordsByCluster.set(keyword.cluster_key, (keywordsByCluster.get(keyword.cluster_key) || 0) + 1);
  }
  const territoryLines = draft.territories.map((territory) =>
    `  ${territory.key} — ${territory.name} [${territory.priority_band}/${territory.status}]`);
  const clusterLines = draft.clusters.map((cluster) => {
    const count = keywordsByCluster.get(cluster.key) || 0;
    return `  ${cluster.key} — ${cluster.name} (territory: ${cluster.territory_key}) — `
      + (count ? `${count} keywords written` : 'no keywords yet');
  });
  const sections = draft.sections
    ? Object.entries(draft.sections).map(([name, value]) => `${name}${String(value || '').trim() ? '' : ' (empty)'}`)
    : [];
  // Terms are listed, their eighteen fields are not: enough for the model to
  // avoid repeating itself, without carrying the whole keyword map every turn.
  const writtenTerms = draft.keywords.map((keyword) => `${keyword.term} → ${keyword.cluster_key}`);
  return [
    `STRATEGY DRAFT (locale ${draft.locale})`,
    `Territories (${draft.territories.length}):`,
    territoryLines.join('\n') || '  none',
    `Clusters (${draft.clusters.length}):`,
    clusterLines.join('\n') || '  none',
    `Sections: ${sections.join(', ') || 'none written'}`,
    `Keywords already written (${draft.keywords.length}):`,
    writtenTerms.length ? writtenTerms.map((line) => `  ${line}`).join('\n') : '  none',
  ].join('\n');
}

/** The eleven prose fields, lifted off a freshly generated blueprint. */
export function strategyDraftSectionsOf(blueprint: StrategyBlueprint): StrategyDraftSections {
  return {
    change_summary: blueprint.change_summary,
    research_scope_summary: blueprint.research_scope_summary,
    executive_strategy: blueprint.executive_strategy,
    search_landscape: blueprint.search_landscape,
    selected_playbooks: blueprint.selected_playbooks,
    site_architecture: blueprint.site_architecture,
    internal_linking: blueprint.internal_linking,
    roadmap: blueprint.roadmap,
    measurement: blueprint.measurement,
    risks_unknowns: blueprint.risks_unknowns,
    evidence_notes: blueprint.evidence_notes,
  };
}

/**
 * Rebuilds the blueprint from the draft, so keyword batches and the final
 * assembly read the persisted skeleton rather than a variable that only exists
 * while one Run is alive. A successor resuming after its predecessor wrote the
 * blueprint gets exactly what that predecessor produced.
 */
export function strategyBlueprintOf(draft: StrategyDraftContent): StrategyBlueprint {
  if (!draft.sections) throw new Error('Strategy draft has no blueprint sections');
  return { ...draft.sections, territories: draft.territories, clusters: draft.clusters };
}
