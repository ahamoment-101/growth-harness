import { newId, isoNow } from '../../db';
import type { Competitor, CompetitorPage, Site } from '../../types';
import type { FetchedPage } from './fetch';

export async function syncCompetitors(db: D1Database, site: Site, domains: string[]): Promise<Competitor[]> {
  const existing = await listCompetitors(db, site.id);
  const byDomain = new Map(existing.map((c) => [c.domain, c]));
  const keep = new Set(domains);
  for (const row of existing) {
    if (!keep.has(row.domain)) {
      await db.prepare('delete from competitors where id = ?').bind(row.id).run();
    }
  }
  const now = isoNow();
  const out: Competitor[] = [];
  for (const domain of domains) {
    const hit = byDomain.get(domain);
    if (hit) {
      out.push(hit);
      continue;
    }
    const row: Competitor = {
      id: newId(),
      site_id: site.id,
      domain,
      brand: '',
      positioning: '',
      source: 'manual',
      first_seen_at: now,
      last_fetched_at: '',
    };
    await db
      .prepare(
        `insert into competitors (id, site_id, domain, brand, positioning, source, first_seen_at, last_fetched_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, row.site_id, row.domain, row.brand, row.positioning, row.source, row.first_seen_at, row.last_fetched_at)
      .run();
    out.push(row);
  }
  return out;
}

export async function listCompetitors(db: D1Database, siteId: string): Promise<Competitor[]> {
  const { results } = await db
    .prepare('select * from competitors where site_id = ? order by domain asc')
    .bind(siteId)
    .all<Competitor>();
  return results ?? [];
}

export async function replaceCompetitorPages(
  db: D1Database,
  competitorId: string,
  pages: FetchedPage[],
): Promise<number> {
  const now = isoNow();
  await db.prepare('delete from competitor_pages where competitor_id = ?').bind(competitorId).run();
  let n = 0;
  for (const page of pages) {
    await db
      .prepare(
        `insert into competitor_pages (id, competitor_id, url, title, keyword_hint, content_type, fetched_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(newId(), competitorId, page.url, page.title, page.keyword_hint, '', now)
      .run();
    n += 1;
  }
  await db.prepare('update competitors set last_fetched_at = ? where id = ?').bind(now, competitorId).run();
  return n;
}

export async function listCompetitorPages(db: D1Database, competitorIds: string[]): Promise<CompetitorPage[]> {
  if (!competitorIds.length) return [];
  const out: CompetitorPage[] = [];
  for (const id of competitorIds) {
    const { results } = await db
      .prepare('select * from competitor_pages where competitor_id = ? order by fetched_at desc limit 200')
      .bind(id)
      .all<CompetitorPage>();
    out.push(...(results ?? []));
  }
  return out;
}


export async function latestGscQueries(
  db: D1Database,
  siteId: string,
): Promise<Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number; as_of: string }>> {
  const latest = await db
    .prepare("select max(date) as d from gsc_analytics where site_id = ? and dimension = 'query'")
    .bind(siteId)
    .first<{ d: string | null }>();
  if (!latest?.d) return [];
  const { results } = await db
    .prepare(
      "select key, clicks, impressions, ctr, position from gsc_analytics where site_id = ? and dimension = 'query' and date = ? order by impressions desc limit 200",
    )
    .bind(siteId, latest.d)
    .all<{ key: string; clicks: number; impressions: number; ctr: number; position: number }>();
  return (results ?? []).map((r) => ({
    query: r.key,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
    as_of: latest.d || '',
  }));
}
