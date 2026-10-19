import type { SiteLedger, LedgerCount } from '../../shared/site-ledger';
import { readRuntimeJson } from '../agent-runtime/runtime-content';

type Scope = { db: D1Database; workspaceId: string; siteId: string };
export function ledgerDayWindow(now: number) {
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const end = Date.parse(`${today}T00:00:00+08:00`);
  return { start: new Date(end - 86400000).toISOString(), end: new Date(end).toISOString() };
}
const count = (row?: Record<string, unknown>): LedgerCount => ({ total: Number(row?.total || 0), yesterday: Number(row?.yesterday || 0) });

/** Site-scoped aggregates only. Never load articles, model messages or source-page bodies into the Worker. */
export async function aggregateLedger({ db, workspaceId, siteId }: Scope, now: number): Promise<SiteLedger> {
  const window = ledgerDayWindow(now);
  const yesterday = (column: string) => `julianday(${column})>=julianday(?) and julianday(${column})<julianday(?)`;
  const published = "site_id=? and status='published' and visibility!='hidden'";
  const results = await db.batch([
    db.prepare(`select count(*) total,coalesce(sum(${yesterday('published_at')}),0) yesterday from jobs where ${published}`)
      .bind(window.start, window.end, siteId),
    db.prepare(`select count(*) total,coalesce(sum(${yesterday("(select min(v2.created_at) from seo_strategy_versions v2 where v2.site_id=v.site_id and v2.source_locale=v.source_locale and v2.status!='draft' and exists(select 1 from seo_strategy_documents d2 where d2.strategy_version_id=v2.id and d2.doc_type in ('strategy','research_notes') and length(trim(d2.body_md))>0))")}),0) yesterday
      from seo_strategy_versions v where v.site_id=? and v.status='active'
      and exists(select 1 from seo_strategy_documents d where d.strategy_version_id=v.id and d.doc_type in ('strategy','research_notes') and length(trim(d.body_md))>0)`)
      .bind(window.start, window.end, siteId),
    db.prepare(`select count(*) total,coalesce(sum(${yesterday("(select min(d2.created_at) from seo_strategy_versions v2 join seo_strategy_documents d2 on d2.strategy_version_id=v2.id where v2.site_id=v.site_id and v2.source_locale=v.source_locale and v2.status!='draft' and d2.doc_type='keyword_map' and length(trim(d2.body_md))>0)")}),0) yesterday
      from seo_strategy_versions v join seo_strategy_documents d on d.strategy_version_id=v.id
      where v.site_id=? and v.status='active' and d.doc_type='keyword_map' and length(trim(d.body_md))>0`)
      .bind(window.start, window.end, siteId),
    db.prepare(`select count(*) total,coalesce(sum(${yesterday('created_at')}),0) yesterday from keyword_library_entries
      where workspace_id=? and site_id=? and kind='keyword' and archived=0`)
      .bind(window.start, window.end, workspaceId, siteId),
    db.prepare(`select count(*) total,coalesce(sum(${yesterday('reviewed_at')}),0) yesterday from topic_decision_results
      where workspace_id=? and site_id=? and status='handed_off'`)
      .bind(window.start, window.end, workspaceId, siteId),
    db.prepare(`with published as (select case when json_valid(versions_json) then case when json_type(versions_json)='array' then versions_json else '[]' end else '[]' end versions_json,en_slug,en_title,en_content,pt_slug,pt_title,pt_content from jobs where ${published}),
      versioned as (select * from published where json_valid(versions_json) and json_type(versions_json)='array' and json_array_length(versions_json)>0),
      locales as (
        select trim(json_extract(v.value,'$.locale')) locale from versioned j,json_each(j.versions_json) v
          where v.type='object' and json_type(v.value,'$.locale')='text' and length(trim(json_extract(v.value,'$.locale')))>0
        union select 'en' from published where (not json_valid(versions_json) or json_type(versions_json)!='array' or json_array_length(versions_json)=0)
          and (coalesce(en_slug,'')!='' or coalesce(en_title,'')!='' or coalesce(en_content,'')!='')
        union select 'pt-BR' from published where (not json_valid(versions_json) or json_type(versions_json)!='array' or json_array_length(versions_json)=0)
          and (coalesce(pt_slug,'')!='' or coalesce(pt_title,'')!='' or coalesce(pt_content,'')!='')
      ) select count(distinct locale) total from locales`).bind(siteId),
    db.prepare('select gsc_sitemap_submit_status,gsc_oauth_status from sites where workspace_id=? and id=?').bind(workspaceId, siteId),
    db.prepare(`with latest as (select max(date) through from gsc_daily where site_id=?)
      select coalesce(sum(impressions),0) impressions,coalesce(sum(clicks),0) clicks,
      date(latest.through,'-6 days') as start_date,latest.through,max(fetched_at) synced_at
      from latest left join gsc_daily d on d.site_id=? and d.date between date(latest.through,'-6 days') and latest.through`)
      .bind(siteId, siteId),
    db.prepare(`select count(*) total,coalesce(sum(${yesterday('updated_at')}),0) yesterday from agent_tasks
      where workspace_id=? and site_id=? and agent_id='deep_research'
      and json_type(output_json,'$.report')='text' and length(trim(json_extract(output_json,'$.report')))>0`)
      .bind(window.start, window.end, workspaceId, siteId),
  ]);
  const rows = results.map(result => result.results[0] as Record<string, unknown> | undefined);
  const research = count(rows[2]);
  const reports = count(rows[8]);
  research.total += reports.total; research.yesterday += reports.yesterday;
  // Older large report receipts use chunk references. Inspect only those receipts in bounded pages;
  // counting the pointer as a report would falsely count outputs with no saved report.
  let after = '';
  for (;;) {
    const page = await db.prepare(`select id,output_json,updated_at from agent_tasks where workspace_id=? and site_id=?
      and agent_id='deep_research' and id>? and json_type(output_json,'$.$runtime_content')='text' order by id limit 50`)
      .bind(workspaceId, siteId, after).all<{ id: string; output_json: string; updated_at: string }>();
    for (const task of page.results) {
      const output = await readRuntimeJson<{ report?: unknown }>(db, task.output_json);
      if (typeof output?.report === 'string' && output.report.trim()) {
        research.total++;
        if (Date.parse(task.updated_at) >= Date.parse(window.start) && Date.parse(task.updated_at) < Date.parse(window.end)) research.yesterday++;
      }
    }
    if (page.results.length < 50) break;
    after = page.results.at(-1)!.id;
  }
  const site = rows[6];
  if (!site) throw new Error('site not found');
  const gsc = rows[7];
  return {
    published: count(rows[0]), strategies: count(rows[1]), research, keywords: count(rows[3]), topics: count(rows[4]),
    languages: Number(rows[5]?.total || 0),
    sitemap: site.gsc_sitemap_submit_status === 'success' ? 'submitted' : site.gsc_sitemap_submit_status === 'error' ? 'error' : 'not_submitted',
    search: site.gsc_oauth_status === 'connected' && gsc?.through ? {
      impressions: Number(gsc.impressions), clicks: Number(gsc.clicks), from: String(gsc.start_date), through: String(gsc.through), synced_at: String(gsc.synced_at || ''),
    } : null,
    computed_at: new Date(now).toISOString(), timezone: 'Asia/Shanghai',
  };
}
