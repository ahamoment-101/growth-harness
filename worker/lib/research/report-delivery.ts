import type { D1Database } from '@cloudflare/workers-types';
import { ToolContractError } from '../../agent-runtime/tool-failure';

export const strategyReportTypes = ['strategy', 'keyword_map', 'research_notes'] as const;

/** Strategy versions produced from definition v34 have no keyword map report; keywords live in the library. */
export function requiredStrategyReportTypes(definitionVersion: number): ReadonlyArray<typeof strategyReportTypes[number]> {
  return definitionVersion >= 34 ? strategyReportTypes.filter(type => type !== 'keyword_map') : strategyReportTypes;
}

export async function strategyReportDelivery(db: D1Database, siteId: string, locale: string, versionId: string) {
  const version = versionId ? await db.prepare(`select v.id,v.locale_version,
      coalesce((select t.definition_version from agent_task_runs r join agent_tasks t on t.id=r.task_id where r.run_id=v.run_id and t.agent_id='strategy_research' limit 1),0) as definition_version
    from seo_strategy_versions v where v.id=? and v.site_id=? and v.source_locale=? and v.status!='draft'`).bind(versionId, siteId, locale)
    .first<{ id: string; locale_version: number; definition_version: number }>() : null;
  if (!version) return { version_id: '', version: 0, complete: false, present: [], missing: [...strategyReportTypes] };
  const required = requiredStrategyReportTypes(Number(version.definition_version || 0));
  const rows = await db.prepare('select doc_type from seo_strategy_documents where strategy_version_id=? and length(trim(body_md))>0')
    .bind(version.id).all<{ doc_type: string }>();
  const present = required.filter(type => rows.results.some(row => row.doc_type === type));
  return { version_id: version.id, version: version.locale_version, complete: present.length === required.length,
    present, missing: required.filter(type => !present.includes(type)) };
}

/** Restore only absent projections of the exact observed version; never edit strategy or existing prose. */
export async function restoreStrategyReports(db: D1Database, siteId: string, locale: string, versionId: string) {
  const before = await strategyReportDelivery(db, siteId, locale, versionId);
  if (!before.version_id) throw new ToolContractError('No authorized saved strategy version is available', {
    kind: 'invalid_request', effects: 'none', issues: [], guidance: 'Read the strategy state. A new strategy can be created and submitted using the strategy workspace tools.',
  });
  await db.batch(strategyReportTypes.map(type => db.prepare(`insert into seo_strategy_documents
    (id,strategy_version_id,doc_type,body_md,content_hash,created_at)
    select ?,s.strategy_version_id,s.doc_type,s.body_md,s.content_hash,s.created_at
    from seo_strategy_report_snapshots s join seo_strategy_versions v on v.id=s.strategy_version_id
    where s.strategy_version_id=? and s.doc_type=? and v.site_id=? and v.source_locale=? and v.status!='draft'
      and length(trim(s.body_md))>0
    on conflict(strategy_version_id,doc_type) do nothing`)
    .bind(crypto.randomUUID(), versionId, type, siteId, locale)));
  const delivery = await strategyReportDelivery(db, siteId, locale, versionId);
  return { delivery, strategy_changed: false, restoration: 'saved_version_snapshot',
    limitations: delivery.complete ? '' : 'Some reports have no recoverable snapshot or an existing empty row. No existing report was overwritten. A historical working draft is not proof of exact submitted text. Inspect saved material and use submit_strategy for a newly generated version if appropriate, or explain what prevents delivery.' };
}
