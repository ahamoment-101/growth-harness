import type { D1Database } from '@cloudflare/workers-types';
import { listBusinessModules, type BusinessModuleView } from '../lib/business';
import { businessModuleMarkdown } from '../../shared/business';
import { latestGscQueries, listCompetitorPages, listCompetitors } from '../lib/research/store';
import { activeStrategyContext, strategyVersionContext } from '../lib/research/strategy-store';
import { listAgentMemories } from './memory';
import { boundedContextValue, type ContextSourceValue } from './context';
import { localeStrategyBrief } from '../lib/research/locale-brief';

type SafeSiteState = {
  id: string;
  workspace_id: string;
  name: string;
  domain: string;
  root_domain: string;
  source_locale: string;
  hub_path: string;
  model: string;
  research_seed_terms_json: string;
  competitor_domains_json: string;
  product_brief: string;
  created_at?: string;
};

/**
 * Byte caps for strategy research context. The sum is below
 * `strategy_research.contextBudgetBytes` (90_000), so no source can be dropped
 * and fail the Run. `research_evidence` and `agent_memory` are the two that
 * grow on their own — competitor pages accumulate as they are crawled, and
 * memory accumulates across Runs.
 */
export const STRATEGY_CONTEXT_BYTE_CAPS = {
  site_state: 8_000,
  // The largest single share, because this is what the whole strategy is
  // derived from and the only source that cannot be re-acquired by research.
  // A customer who fills in all six modules thoroughly used to overflow the old
  // 16k cap, and overflowing does not trim — it collapses the entire set into an
  // unreadable preview blob, which silently removes the foundation while leaving
  // every other source intact.
  business_modules: 36_000,
  search_performance: 12_000,
  research_evidence: 20_000,
  strategy_history: 16_000,
  agent_memory: 10_000,
  inherited_evidence: 40_000,
} as const;

/**
 * Fits the confirmed business foundation inside its cap without destroying it.
 *
 * Bounding the six modules as one value is what the generic helper would do, and
 * it fails badly here: overflowing by a single byte collapses all six into an
 * unreadable preview blob, so one customer writing a long competition section
 * silently removes the product, audience and conversion facts as well. Each
 * module gets its own share first, so overflow costs detail inside the module
 * that overflowed and announces itself there; the whole-set bound stays as the
 * backstop the context budget actually depends on.
 *
 * The markdown is used rather than the parsed field object: it is what a person
 * actually wrote, it costs fewer tokens than the same text wrapped in field
 * keys, and it is the exact rendering the synthesis phase reads. Researching
 * against one shape and writing against another is how a fact ends up present in
 * one half of a Run and absent in the other.
 */
export function boundedBusinessModules(modules: BusinessModuleView[], maxBytes: number): unknown {
  const share = Math.max(1_000, Math.floor(maxBytes / Math.max(1, modules.length)));
  return boundedContextValue(modules.map(({ key, markdown, content, version, schema_version, source, updated_at }) => ({
    key,
    version,
    schema_version,
    source,
    updated_at,
    markdown: boundedContextValue(markdown || businessModuleMarkdown(key, content), share),
  })), maxBytes);
}

export async function loadStrategyResearchContext(
  db: D1Database,
  site: SafeSiteState,
  currentRunId: string,
  sourceLocale: string,
  baseVersionId?: string,
): Promise<ContextSourceValue[]> {
  const [modules, gsc, competitors, previousStrategy, memories, history] = await Promise.all([
    listBusinessModules(db, site.id),
    latestGscQueries(db, site.id),
    listCompetitors(db, site.id),
    baseVersionId === undefined ? activeStrategyContext(db, site.id, sourceLocale) : baseVersionId ? strategyVersionContext(db, baseVersionId) : Promise.resolve(''),
    listAgentMemories(db, site.workspace_id, site.id, 'strategy_research', `strategy:${sourceLocale}`),
    db.prepare(
      `select id, status, phase, error_code, error, summary_json, output_json, started_at, finished_at
       from agent_runs where workspace_id = ? and site_id = ? and agent_id = 'strategy_research' and id <> ?
       and agent_instance_id = ?
       order by created_at desc limit 10`,
    ).bind(site.workspace_id, site.id, currentRunId, `strategy:${sourceLocale}`).all<Record<string, unknown>>(),
  ]);
  const pages = await listCompetitorPages(db, competitors.map((item) => item.id));
  const latestModuleTime = modules.map((item) => item.updated_at).filter(Boolean).sort().at(-1) || '';
  const latestMemoryTime = memories.map((item) => item.created_at).sort().at(-1) || '';
  const latestCompetitorTime = competitors.map((item) => item.last_fetched_at).filter(Boolean).sort().at(-1) || '';

  return [
    {
      sourceId: 'site_state', version: `${site.created_at || '1'}:${sourceLocale}:locale-brief-v1`, capturedAt: site.created_at || '', priority: 100,
      value: boundedContextValue(
        { ...site, source_locale: sourceLocale, locale_strategy_brief: localeStrategyBrief(sourceLocale) },
        STRATEGY_CONTEXT_BYTE_CAPS.site_state,
      ),
    },
    {
      sourceId: 'business_modules',
      version: modules.map((item) => `${item.key}:${item.version}`).join('|'),
      capturedAt: latestModuleTime,
      priority: 95,
      value: modules,
    },
    {
      sourceId: 'search_performance', version: gsc[0]?.as_of || 'none', capturedAt: gsc[0]?.as_of || '', priority: 90,
      value: boundedContextValue(
        { scope: 'site_global', locale_attribution: 'unknown', rows: gsc },
        STRATEGY_CONTEXT_BYTE_CAPS.search_performance,
      ),
    },
    {
      sourceId: 'research_evidence', version: latestCompetitorTime || 'none', capturedAt: latestCompetitorTime, priority: 80,
      value: boundedContextValue(
        { scope: 'project_configured_cross_market', competitors, pages: pages.slice(0, 200) },
        STRATEGY_CONTEXT_BYTE_CAPS.research_evidence,
      ),
    },
    {
      sourceId: 'strategy_history', version: previousStrategy ? baseVersionId || 'active' : 'none', capturedAt: '', priority: 75,
      value: boundedContextValue(
        { active_strategy: previousStrategy, previous_runs: history.results ?? [] },
        STRATEGY_CONTEXT_BYTE_CAPS.strategy_history,
      ),
    },
    {
      sourceId: 'agent_memory', version: memories.map((item) => `${item.kind}:${item.version}`).join('|') || 'none',
      capturedAt: latestMemoryTime, priority: 70,
      value: boundedContextValue(memories.map((item) => ({
        id: item.id, kind: item.kind, version: item.version, content_json: item.content_json,
        evidence_refs_json: item.evidence_refs_json, source_run_id: item.source_run_id,
        supersedes_memory_id: item.supersedes_memory_id, created_at: item.created_at,
      })), STRATEGY_CONTEXT_BYTE_CAPS.agent_memory),
    },
  ];
}
