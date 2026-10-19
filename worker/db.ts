import { generationLocales, jobGenerationLocales, webhookFieldsOf, translateLocalesOf } from './lib/webhook';
import { DEFAULT_CNAME_TARGET, probeUrl } from './lib/hosting';
import { jobVersions, orderVersions } from './lib/versions';
import { localePolicyOf, parseHubUrls, publicLocalePolicy, seoIdentityOf, sourceLocaleOf } from './blog/seo';
import { nameByLocaleOf } from './blog/site-name';
import { registrableDomain } from '../shared/domain';
import { normalizeBlogLayout } from '../shared/blog-layouts';
import { nextArticleAliases } from './blog/url-history';
import type { Job, JobStatus, Site, Topic } from './types';

function nowIso() {
  return new Date().toISOString();
}

export async function getSite(db: D1Database, id: string): Promise<Site | null> {
  return db.prepare('select * from sites where id = ?').bind(id).first<Site>();
}

export async function getSiteForWorkspace(db: D1Database, workspaceId: string, id: string): Promise<Site | null> {
  return db.prepare('select * from sites where workspace_id = ? and id = ?').bind(workspaceId, id).first<Site>();
}

export async function listSites(db: D1Database): Promise<Site[]> {
  const { results } = await db.prepare('select * from sites order by created_at desc').all<Site>();
  return results ?? [];
}

export async function getSiteByDomain(db: D1Database, domain: string): Promise<Site | null> {
  const host = domain.trim().toLowerCase();
  if (!host) return null;
  // `domain != ''` lets SQLite use the partial unique index; without it every blog request scans sites.
  return db.prepare("select * from sites where domain = ? and domain != ''").bind(host).first<Site>();
}

export async function getSiteByRootDomain(db: D1Database, root: string): Promise<Site | null> {
  const host = root.trim().toLowerCase();
  if (!host) return null;
  return db.prepare("select * from sites where root_domain = ? and root_domain != ''").bind(host).first<Site>();
}

export async function insertSite(db: D1Database, site: Site): Promise<void> {
  await db
    .prepare(
      `insert into sites (
        id,
        workspace_id,
        name,
        domain,
        root_domain,
        ingest_url,
        ingest_secret,
        secret_header,
        locales_json,
        translate_locales_json,
        webhook_fields_json,
        webhook_mode,
        hub_path,
        product_origin,
        locale_policy_json,
        source_locale,
        hub_urls_json,
        seo_identity_json,
        name_by_locale_json,
        blog_layout,
        publication_language_mode,
        model,
        min_words,
        created_at,
        domain_status,
        domain_error,
        domain_checked_at,
        gsc_oauth_status,
        gsc_google_account_email,
        gsc_property_url_prefix,
        gsc_property_verification_status,
        gsc_property_verified_at,
        gsc_verification_meta_token,
        gsc_sitemap_submit_status,
        gsc_sitemap_last_submit_at,
        gsc_refresh_token_cipher
      )
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      site.id,
      site.workspace_id,
      site.name,
      site.domain,
      site.root_domain,
      site.ingest_url,
      site.ingest_secret,
      site.secret_header,
      site.locales_json,
      site.translate_locales_json,
      site.webhook_fields_json,
      site.webhook_mode,
      site.hub_path,
      site.product_origin,
      site.locale_policy_json,
      site.source_locale,
      site.hub_urls_json,
      site.seo_identity_json,
      site.name_by_locale_json || '{}',
      site.blog_layout,
      site.publication_language_mode || 'all_enabled',
      site.model,
      site.min_words,
      site.created_at,
      site.domain_status,
      site.domain_error,
      site.domain_checked_at,
      site.gsc_oauth_status,
      site.gsc_google_account_email,
      site.gsc_property_url_prefix,
      site.gsc_property_verification_status,
      site.gsc_property_verified_at,
      site.gsc_verification_meta_token,
      site.gsc_sitemap_submit_status,
      site.gsc_sitemap_last_submit_at,
      site.gsc_refresh_token_cipher,
    )
    .run();
}

export async function updateSite(
  db: D1Database,
  id: string,
  patch: Partial<Omit<Site, 'id' | 'created_at'>>,
  workspaceId?: string,
): Promise<void> {
  const current = workspaceId ? await getSiteForWorkspace(db, workspaceId, id) : await getSite(db, id);
  if (!current) throw new Error('site not found');
  const domainChanged = patch.domain != null && patch.domain !== current.domain;
  const next = {
    ...current,
    ...patch,
    domain_status: domainChanged ? 'unverified' : (patch.domain_status ?? current.domain_status),
    domain_error: domainChanged ? '' : (patch.domain_error ?? current.domain_error),
    domain_checked_at: domainChanged ? '' : (patch.domain_checked_at ?? current.domain_checked_at),
  };
  const result = await db
    .prepare(
      `update sites set
        name=?,
        domain=?,
        root_domain=?,
        ingest_url=?,
        ingest_secret=?,
        secret_header=?,
        locales_json=?,
        translate_locales_json=?,
        webhook_fields_json=?,
        webhook_mode=?,
        hub_path=?,
        product_origin=?,
        locale_policy_json=?,
        source_locale=?,
        hub_urls_json=?,
        seo_identity_json=?,
        name_by_locale_json=?,
        blog_layout=?,
        publication_language_mode=?,
        model=?,
        min_words=?,
        domain_status=?,
        domain_error=?,
        domain_checked_at=?,
        gsc_oauth_status=?,
        gsc_google_account_email=?,
        gsc_property_url_prefix=?,
        gsc_property_verification_status=?,
        gsc_property_verified_at=?,
        gsc_verification_meta_token=?,
        gsc_sitemap_submit_status=?,
        gsc_sitemap_last_submit_at=?,
        gsc_refresh_token_cipher=?
       where id=?${workspaceId ? ' and workspace_id=?' : ''}`,
    )
    .bind(
      next.name,
      next.domain,
      next.root_domain,
      next.ingest_url,
      next.ingest_secret,
      next.secret_header,
      next.locales_json,
      next.translate_locales_json,
      next.webhook_fields_json,
      next.webhook_mode,
      next.hub_path,
      next.product_origin,
      next.locale_policy_json,
      next.source_locale,
      next.hub_urls_json,
      next.seo_identity_json,
      next.name_by_locale_json || '{}',
      next.blog_layout,
      next.publication_language_mode || 'all_enabled',
      next.model,
      next.min_words,
      next.domain_status,
      next.domain_error,
      next.domain_checked_at,
      next.gsc_oauth_status,
      next.gsc_google_account_email,
      next.gsc_property_url_prefix,
      next.gsc_property_verification_status,
      next.gsc_property_verified_at,
      next.gsc_verification_meta_token,
      next.gsc_sitemap_submit_status,
      next.gsc_sitemap_last_submit_at,
      next.gsc_refresh_token_cipher,
      id,
      ...(workspaceId ? [workspaceId] : []),
    )
    .run();
  if (workspaceId && !result.meta.changes) throw new Error('site not found');
}

export async function listTopics(db: D1Database, siteId: string): Promise<Topic[]> {
  const { results } = await db
    .prepare('select * from topics where site_id = ? order by created_at asc')
    .bind(siteId)
    .all<Topic>();
  return results ?? [];
}

export async function getTopic(db: D1Database, id: string): Promise<Topic | null> {
  return db.prepare('select * from topics where id = ?').bind(id).first<Topic>();
}

export async function getTopicForWorkspace(
  db: D1Database,
  workspaceId: string,
  siteId: string,
  id: string,
): Promise<Topic | null> {
  return db.prepare(
    `select t.* from topics t join sites s on s.id = t.site_id
     where s.workspace_id = ? and t.site_id = ? and t.id = ?`,
  ).bind(workspaceId, siteId, id).first<Topic>();
}

export async function insertTopic(db: D1Database, topic: Topic): Promise<void> {
  await db
    .prepare(
      `insert into topics (id, site_id, topic_key, title_hint, category, primary_keyword, status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      topic.id,
      topic.site_id,
      topic.topic_key,
      topic.title_hint,
      topic.category,
      topic.primary_keyword,
      topic.status,
      topic.created_at,
    )
    .run();
}

export async function getJob(db: D1Database, id: string): Promise<Job | null> {
  return db.prepare('select * from jobs where id = ?').bind(id).first<Job>();
}

export async function getJobForWorkspace(db: D1Database, workspaceId: string, id: string): Promise<Job | null> {
  return db.prepare(
    `select j.* from jobs j join sites s on s.id = j.site_id
     where s.workspace_id = ? and j.id = ?`,
  ).bind(workspaceId, id).first<Job>();
}

export async function listJobs(
  db: D1Database,
  siteId: string,
  status?: string,
): Promise<Job[]> {
  if (status) {
    const { results } = await db
      .prepare('select * from jobs where site_id = ? and status = ? order by created_at desc')
      .bind(siteId, status)
      .all<Job>();
    return results ?? [];
  }
  const { results } = await db
    .prepare('select * from jobs where site_id = ? order by created_at desc')
    .bind(siteId)
    .all<Job>();
  return results ?? [];
}

export async function insertJob(db: D1Database, job: Job): Promise<void> {
  await db
    .prepare(
      `insert into jobs (
        id, site_id, topic_id, status, visibility, translation_group, category, translate_locales_json, versions_json, source_locale,
        en_slug, en_title, en_excerpt, en_content,
        pt_slug, pt_title, pt_excerpt, pt_content,
        qa_report, review_note, workflow_id, error, publish_response, published_at, content_updated_at,
        created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      job.id,
      job.site_id,
      job.topic_id,
      job.status,
      job.visibility || 'visible',
      job.translation_group,
      job.category,
      job.translate_locales_json,
      job.versions_json,
      job.source_locale || '',
      job.en_slug,
      job.en_title,
      job.en_excerpt,
      job.en_content,
      job.pt_slug,
      job.pt_title,
      job.pt_excerpt,
      job.pt_content,
      job.qa_report,
      job.review_note,
      job.workflow_id,
      job.error,
      job.publish_response,
      job.published_at,
      job.content_updated_at,
      job.created_at,
      job.updated_at,
    )
    .run();
}

export async function updateJob(
  db: D1Database,
  id: string,
  patch: Partial<Omit<Job, 'id' | 'created_at'>>,
  workspaceId?: string,
): Promise<void> {
  const current = workspaceId ? await getJobForWorkspace(db, workspaceId, id) : await getJob(db, id);
  if (!current) throw new Error('job not found');
  const next = { ...current, ...patch, updated_at: nowIso() };
  next.url_aliases_json = nextArticleAliases(current);
  const result = await db
    .prepare(
      `update jobs set
        site_id=?, topic_id=?, status=?, visibility=?, translation_group=?, category=?, translate_locales_json=?, versions_json=?, source_locale=?,
        en_slug=?, en_title=?, en_excerpt=?, en_content=?,
        pt_slug=?, pt_title=?, pt_excerpt=?, pt_content=?,
        qa_report=?, review_note=?, workflow_id=?, error=?, publish_response=?, published_at=?, content_updated_at=?,
        updated_at=?, url_aliases_json=?
       where id=?${workspaceId ? ' and exists (select 1 from sites where sites.id = jobs.site_id and sites.workspace_id = ?)' : ''}`,
    )
    .bind(
      next.site_id,
      next.topic_id,
      next.status,
      next.visibility || 'visible',
      next.translation_group,
      next.category,
      next.translate_locales_json,
      next.versions_json,
      next.source_locale || '',
      next.en_slug,
      next.en_title,
      next.en_excerpt,
      next.en_content,
      next.pt_slug,
      next.pt_title,
      next.pt_excerpt,
      next.pt_content,
      next.qa_report,
      next.review_note,
      next.workflow_id,
      next.error,
      next.publish_response,
      next.published_at,
      next.content_updated_at,
      next.updated_at,
      next.url_aliases_json,
      id,
      ...(workspaceId ? [workspaceId] : []),
    )
    .run();
  if (workspaceId && !result.meta.changes) throw new Error('job not found');
}

export function publicJob(job: Job, locales: string[] = []) {
  const ordered = locales.length ? locales : jobGenerationLocales(job);
  const versions = orderVersions(jobVersions(job), ordered);
  const primary = versions[0];
  return {
    id: job.id,
    site_id: job.site_id,
    topic_id: job.topic_id,
    decision_group_id: job.decision_group_id || null,
    decision_item_id: job.decision_item_id || null,
    production_group_id: job.production_group_id || null,
    current_artifact_id: job.current_artifact_id || null,
    child_run_id: job.child_run_id || null,
    plan: (() => { try { return JSON.parse(job.plan_json || '{}'); } catch { return {}; } })(),
    status: job.status,
    visibility: job.visibility || 'visible',
    translation_group: job.translation_group,
    category: job.category,
    source_locale: job.source_locale || '',
    translate_locales: ordered.filter((l) => l !== (ordered[0] || 'en')),
    versions,
    title: primary?.title || job.translation_group,
    slug: primary?.slug || null,
    qa_report: job.qa_report,
    review_note: job.review_note,
    workflow_id: job.workflow_id,
    error: job.error,
    publish_response: job.publish_response,
    published_at: job.published_at,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

export function livePath(siteId: string): string {
  return `/live/${siteId}`;
}

export type SiteCounts = {
  awaiting_review: number;
  published: number;
  queued_topics: number;
};

/** Counts only the requested sites; never walks other tenants' rows. */
export async function countsForSites(db: D1Database, siteIds: readonly string[]): Promise<Map<string, SiteCounts>> {
  const map = new Map<string, SiteCounts>();
  if (!siteIds.length) return map;
  const ids = JSON.stringify([...new Set(siteIds)]);
  const jobs = await db
    .prepare(
      `select site_id, status, count(*) as n from jobs
       where site_id in (select value from json_each(?)) and status in ('awaiting_review', 'published')
       group by site_id, status`,
    )
    .bind(ids)
    .all<{ site_id: string; status: string; n: number }>();
  for (const row of jobs.results ?? []) {
    const cur = map.get(row.site_id) ?? { awaiting_review: 0, published: 0, queued_topics: 0 };
    if (row.status === 'awaiting_review') cur.awaiting_review = Number(row.n);
    if (row.status === 'published') cur.published = Number(row.n);
    map.set(row.site_id, cur);
  }
  const topics = await db
    .prepare("select site_id, count(*) as n from topics where site_id in (select value from json_each(?)) and status = 'queued' group by site_id")
    .bind(ids)
    .all<{ site_id: string; n: number }>();
  for (const row of topics.results ?? []) {
    const cur = map.get(row.site_id) ?? { awaiting_review: 0, published: 0, queued_topics: 0 };
    cur.queued_topics = Number(row.n);
    map.set(row.site_id, cur);
  }
  return map;
}

export function emptyCounts(): SiteCounts {
  return { awaiting_review: 0, published: 0, queued_topics: 0 };
}

export function publicSite(site: Site, counts?: SiteCounts, cname_target = DEFAULT_CNAME_TARGET) {
  const translate_locales = translateLocalesOf(site);
  const n = counts ?? emptyCounts();
  const live = site.domain_status === 'live' && Boolean(site.domain);
  return {
    id: site.id,
    workspace_id: site.workspace_id,
    name: site.name,
    domain: site.domain,
    root_domain: site.root_domain || registrableDomain(site.domain),
    live_path: livePath(site.id),
    domain_status: site.domain_status || 'unverified',
    domain_error: site.domain_error || '',
    domain_checked_at: site.domain_checked_at || '',
    cname_target,
    probe_url: site.domain ? probeUrl(site.domain) : `${livePath(site.id)}/`,
    hosted_url: live ? `https://${site.domain}` : livePath(site.id),
    awaiting_review: n.awaiting_review,
    published: n.published,
    queued_topics: n.queued_topics,
    ingest_url: site.ingest_url,
    secret_header: site.secret_header,
    secret_set: Boolean(site.ingest_secret),
    source_locale: sourceLocaleOf(site),
    translate_locales,
    locales: generationLocales(site),
    webhook_fields: webhookFieldsOf(site),
    hub_path: site.hub_path,
    product_origin: site.product_origin || '',
    hub_urls: parseHubUrls(site.hub_urls_json),
    locale_policy: publicLocalePolicy(localePolicyOf(site)),
    seo_identity: seoIdentityOf(site),
    name_by_locale: nameByLocaleOf(site),
    blog_layout: normalizeBlogLayout(site.blog_layout),
    publication_language_mode: site.publication_language_mode || 'all_enabled',
    min_words: site.min_words,
    created_at: site.created_at,

    // Search Console placeholders
    gsc_oauth_status: site.gsc_oauth_status,
    gsc_google_account_email: site.gsc_google_account_email,
    gsc_property_url_prefix: site.gsc_property_url_prefix,
    gsc_property_verification_status: site.gsc_property_verification_status,
    gsc_property_verified_at: site.gsc_property_verified_at,
    gsc_verification_meta_token: site.gsc_verification_meta_token,
    gsc_sitemap_submit_status: site.gsc_sitemap_submit_status,
    gsc_sitemap_last_submit_at: site.gsc_sitemap_last_submit_at,
  };
}

export function newId(): string {
  return crypto.randomUUID();
}

export function isoNow(): string {
  return nowIso();
}

export function emptyJob(partial: Pick<Job, 'id' | 'site_id'> & Partial<Job>): Job {
  const t = nowIso();
  return {
    topic_id: null,
    status: 'queued',
    visibility: 'visible',
    translation_group: null,
    category: null,
    translate_locales_json: '[]',
    source_locale: '',
    versions_json: '[]',
    en_slug: null,
    en_title: null,
    en_excerpt: null,
    en_content: null,
    pt_slug: null,
    pt_title: null,
    pt_excerpt: null,
    pt_content: null,
    qa_report: null,
    review_note: null,
    workflow_id: null,
    error: null,
    publish_response: null,
    published_at: null,
    content_updated_at: null,
    created_at: t,
    updated_at: t,
    ...partial,
  };
}

export type { JobStatus };

// ─── GSC Analytics storage ───────────────────────────────────────────────────

export type GscAnalyticsRow = {
  id: string;
  site_id: string;
  date: string;
  dimension: string;
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  fetched_at: string;
};

export type GscDailyRow = {
  id: string;
  site_id: string;
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  fetched_at: string;
};

export async function upsertGscAnalytics(db: D1Database, rows: GscAnalyticsRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) {
    await db.batch(rows.slice(i, i + 100).map((r) => db.prepare(
        `insert or replace into gsc_analytics (id, site_id, date, dimension, key, clicks, impressions, ctr, position, fetched_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(r.id, r.site_id, r.date, r.dimension, r.key, r.clicks, r.impressions, r.ctr, r.position, r.fetched_at)));
  }
}

export async function upsertGscDaily(db: D1Database, rows: GscDailyRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) {
    await db.batch(rows.slice(i, i + 100).map((r) => db.prepare(
        `insert or replace into gsc_daily (id, site_id, date, clicks, impressions, ctr, position, fetched_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(r.id, r.site_id, r.date, r.clicks, r.impressions, r.ctr, r.position, r.fetched_at)));
  }
}

export async function queryGscAnalytics(
  db: D1Database,
  siteId: string,
  dimension: string,
  startDate: string,
  endDate: string,
  limit = 100,
  offset = 0,
): Promise<GscAnalyticsRow[]> {
  const result = await db
    .prepare('select * from gsc_analytics where site_id = ? and dimension = ? and date = (select max(date) from gsc_analytics where site_id = ? and dimension = ? and date >= ? and date <= ?) order by clicks desc, impressions desc limit ? offset ?')
    .bind(siteId, dimension, siteId, dimension, startDate, endDate, limit, offset)
    .all<GscAnalyticsRow>();
  return result.results ?? [];
}

export async function countGscAnalytics(db: D1Database, siteId: string, dimension: string, startDate: string, endDate: string): Promise<number> {
  const row = await db.prepare('select count(*) as n from gsc_analytics where site_id = ? and dimension = ? and date = (select max(date) from gsc_analytics where site_id = ? and dimension = ? and date >= ? and date <= ?)')
    .bind(siteId, dimension, siteId, dimension, startDate, endDate).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function queryGscDaily(
  db: D1Database,
  siteId: string,
  startDate: string,
  endDate: string,
): Promise<GscDailyRow[]> {
  const result = await db
    .prepare('select * from gsc_daily where site_id = ? and date >= ? and date <= ? order by date asc')
    .bind(siteId, startDate, endDate)
    .all<GscDailyRow>();
  return result.results ?? [];
}

export async function latestGscFetchDate(db: D1Database, siteId: string): Promise<string | null> {
  const row = await db
    .prepare('select max(date) as d from gsc_daily where site_id = ?')
    .bind(siteId)
    .first<{ d: string | null }>();
  return row?.d ?? null;
}
