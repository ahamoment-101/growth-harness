import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { getAccessToken, gscSearchAnalyticsAll } from '../lib/gsc';
import { getSiteForWorkspace, getJob } from '../db';
import { articleUrl } from '../blog/seo';
import { publishedLocalePolicy } from '../blog/render';
import type { LearningData, LearningScope } from '../../shared/learning';
import { addEvidence, now, requireRecord } from './store';

type Observation = {
  id: string;
  record_id: string;
  job_id: string;
  artifact_id: string;
  url: string;
  start_date: string;
  end_date: string;
  status: string;
  workspace_id: string;
  site_id: string;
  result_json: string;
  available_at?: string;
};
type GscEnv = RuntimeAgentEnv & {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GSC_TOKEN_CIPHER_KEY?: string;
};
export const gscDay = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
const addDays = (date: string, days: number) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000)
    .toISOString()
    .slice(0, 10);

export async function materializeObservations(env: GscEnv) {
  const rows = await env.DB.prepare(
    `select q.id,q.record_id,e.source_ref,e.payload_json,r.workspace_id,r.site_id from learning_requests q
    join learning_evidence e on e.id=json_extract(q.payload_json,'$.evidence_ref') join learning_records r on r.id=q.record_id
    where q.phase='record' and q.observation_bound=0 and e.kind='publication' order by q.created_at limit 20`,
  ).all<{
    id: string;
    record_id: string;
    source_ref: string;
    payload_json: string;
    workspace_id: string;
    site_id: string;
  }>();
  for (const item of rows.results) {
    const scope = { workspaceId: item.workspace_id, siteId: item.site_id };
    const data: LearningData = JSON.parse(
      (await requireRecord(env.DB, scope, item.record_id)).data_json,
    );
    const job = await getJob(env.DB, item.source_ref),
      site = await getSiteForWorkspace(env.DB, scope.workspaceId, scope.siteId);
    if (!job || job.site_id !== scope.siteId || !site || !job.published_at)
      continue;
    const publication = JSON.parse(item.payload_json) as {
      versions: Array<{ locale: string; slug: string }>;
      published_at: string;
      artifact_id: string;
      site_domain?: string;
      locale_policy_json?: unknown;
    };
    const domain = publication.site_domain ?? site.domain;
    const plan = data.experience.observation;
    if (plan?.source === 'gsc' && domain && site.domain_status === 'live') {
      const versions = publication.versions as Array<{
        locale: string;
        slug: string;
      }>;
      const policy = publishedLocalePolicy(
        {
          ...site,
          locale_policy_json: publication.locale_policy_json
            ? JSON.stringify(publication.locale_policy_json)
            : site.locale_policy_json,
        },
        [],
      );
      const start = gscDay(new Date(publication.published_at)),
        end = addDays(start, plan.days - 1),
        at = now();
      await env.DB.batch(
        versions.map((v) =>
          env.DB.prepare(
            `insert or ignore into learning_observations(id,record_id,job_id,artifact_id,url,start_date,end_date,available_at,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?)`,
          ).bind(
            `${item.id}:${v.locale}`,
            item.record_id,
            job.id,
            publication.artifact_id,
            articleUrl(`https://${domain}`, policy, v.locale, v.slug),
            start,
            end,
            addDays(end, 1) + 'T12:00:00Z',
            at,
            at,
          ),
        ),
      );
    }
    if (
      !plan ||
      plan.source !== 'gsc' ||
      !domain ||
      site.domain_status !== 'live'
    ) {
      await addEvidence(
        env.DB,
        scope,
        item.record_id,
        `observation-gap:${item.id}`,
        'observation_gap',
        item.source_ref,
        {
          reason:
            !plan || plan.source !== 'gsc'
              ? 'No supported pre-action observation plan exists.'
              : 'A verified public domain is unavailable for page observation.',
          artifact_id: publication.artifact_id,
        },
      );
    }
    await env.DB.prepare(
      'update learning_requests set observation_bound=1 where id=?',
    )
      .bind(item.id)
      .run();
  }
}

export async function collectObservation(env: GscEnv, row: Observation) {
  const site = await getSiteForWorkspace(env.DB, row.workspace_id, row.site_id);
  if (
    !site ||
    !site.gsc_refresh_token_cipher ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GSC_TOKEN_CIPHER_KEY
  )
    throw new Error('Search Console connection or credentials unavailable');
  const accessToken = await getAccessToken({
    gscRefreshTokenCipher: site.gsc_refresh_token_cipher,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    cipherKey: env.GSC_TOKEN_CIPHER_KEY,
  });
  const property = site.gsc_property_url_prefix || `https://${site.domain}/`;
  const result = await gscSearchAnalyticsAll({
    siteUrl: property,
    accessToken,
    startDate: row.start_date,
    endDate: row.end_date,
    dimensions: ['date'],
    pageUrl: row.url,
    dataState: 'all',
  });
  const days =
    Math.round(
      (Date.parse(row.end_date) - Date.parse(row.start_date)) / 86400000,
    ) + 1;
  const complete =
    !result.metadata?.first_incomplete_date &&
    result.rows.length === days &&
    new Set(result.rows.map((r) => r.keys[0])).size === days &&
    result.rows.every(
      (r) => r.keys[0] >= row.start_date && r.keys[0] <= row.end_date,
    );
  const clicks = result.rows.reduce((n, r) => n + r.clicks, 0),
    impressions = result.rows.reduce((n, r) => n + r.impressions, 0);
  const position = impressions
    ? result.rows.reduce((n, r) => n + r.position * r.impressions, 0) /
      impressions
    : null;
  return {
    source: 'gsc',
    collected_at: now(),
    url: row.url,
    artifact_id: row.artifact_id,
    start_date: row.start_date,
    end_date: row.end_date,
    time_zone: 'America/Los_Angeles',
    complete,
    coverage: result.rows.map((r) => r.keys[0]),
    first_incomplete_date: result.metadata?.first_incomplete_date || null,
    limitations: complete
      ? []
      : [
          'Some days are missing or provisional; missing rows are not zero measurements.',
        ],
    values: result.rows.length
      ? {
          clicks: { value: clicks, unit: 'count' },
          impressions: { value: impressions, unit: 'count' },
          ...(impressions
            ? {
                ctr: { value: clicks / impressions, unit: 'ratio' },
                position: { value: position!, unit: 'rank' },
              }
            : {}),
        }
      : {},
  };
}
export async function emitPracticeOutcome(
  env: GscEnv,
  scope: LearningScope,
  recordId: string,
) {
  const rows = (
    await env.DB.prepare(
      'select id,job_id,result_json from learning_observations where record_id=? order by id',
    )
      .bind(recordId)
      .all<{ id: string; job_id: string; result_json: string }>()
  ).results;
  if (!rows.length) return;
  const results = rows.map(
    (r) =>
      JSON.parse(r.result_json) as
        | (Omit<Awaited<ReturnType<typeof collectObservation>>, 'values'> & {
            values: Record<string, { value: number; unit: string }>;
          })
        | null,
  );
  const unobserved = await env.DB.prepare(
    `select count(*) n from jobs j join content_production_groups g on g.id=j.production_group_id
    join agent_tasks t on t.active_run_id=g.parent_run_id join learning_tasks l on l.task_id=t.id
    where l.record_id=? and not exists(select 1 from learning_observations o where o.record_id=l.record_id and o.job_id=j.id)`,
  )
    .bind(recordId)
    .first<{ n: number }>();
  const complete = results.every((r) => r?.complete) && !unobserved?.n;
  const values: Record<string, { value: number; unit: string }> = {};
  if (complete) {
    const clicks = results.reduce(
        (n, r) => n + (r!.values.clicks?.value || 0),
        0,
      ),
      impressions = results.reduce(
        (n, r) => n + (r!.values.impressions?.value || 0),
        0,
      );
    values.clicks = { value: clicks, unit: 'count' };
    values.impressions = { value: impressions, unit: 'count' };
    if (impressions) {
      values.ctr = { value: clicks / impressions, unit: 'ratio' };
      values.position = {
        value:
          results.reduce(
            (n, r) =>
              n +
              (r!.values.position?.value || 0) *
                (r!.values.impressions?.value || 0),
            0,
          ) / impressions,
        unit: 'rank',
      };
    }
  }
  const payload = {
    source: 'gsc',
    complete,
    values,
    pages: results,
    limitations: complete
      ? []
      : ['Not all delivered pages and observation windows have complete data.'],
  };
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({
            ...payload,
            pages: results.map((page) => {
              if (!page) return null;
              const { collected_at: _at, ...measurement } = page;
              return measurement;
            }),
          }),
        ),
      ),
    ),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const latest = await env.DB.prepare(
    "select payload_json from learning_evidence where record_id=? and source_ref=? and kind='outcome' order by created_at desc,id desc limit 1",
  )
    .bind(recordId, `gsc:${recordId}`)
    .first<{ payload_json: string }>();
  if (latest && JSON.parse(latest.payload_json).measurement_hash === digest)
    return;
  const collectedAt =
    results
      .flatMap((page) => (page ? [page.collected_at] : []))
      .sort()
      .at(-1) || now();
  const evidenceId = `gsc:${recordId}:${collectedAt}:${digest}`;

  await addEvidence(
    env.DB,
    scope,
    recordId,
    evidenceId,
    'outcome',
    `gsc:${recordId}`,
    { ...payload, measurement_hash: digest },
  );
}
export async function collectDueLearningOutcomes(env: GscEnv, at = new Date()) {
  await materializeObservations(env);
  const due = await env.DB.prepare(
    `select o.*,r.workspace_id,r.site_id from learning_observations o join learning_records r on r.id=o.record_id
    where o.status in ('pending','incomplete','error') and o.available_at<=? order by o.available_at,o.id limit 10`,
  )
    .bind(at.toISOString())
    .all<Observation>();
  for (const row of due.results) {
    let expectedSnapshot = row.result_json;
    try {
      const payload = await collectObservation(env, row);
      const snapshot = JSON.stringify(payload);
      const saved = await env.DB.prepare(
        'update learning_observations set status=?,result_json=?,available_at=?,error=?,updated_at=? where id=? and result_json=? and available_at=?',
      )
        .bind(
          payload.complete ? 'complete' : 'incomplete',
          snapshot,
          new Date(at.getTime() + 86400000).toISOString(),
          payload.limitations.join(' '),
          now(),
          row.id,
          row.result_json,
          row.available_at,
        )
        .run();
      // Another collector already advanced this observation. Its receipt owns feedback.
      if (!saved.meta.changes) continue;
      expectedSnapshot = snapshot;
      await emitPracticeOutcome(
        env,
        { workspaceId: row.workspace_id, siteId: row.site_id },
        row.record_id,
      );
    } catch (error) {
      await env.DB.prepare(
        "update learning_observations set status='error',error=?,available_at=?,updated_at=? where id=? and result_json=?",
      )
        .bind(
          String(error).slice(0, 1000),
          new Date(at.getTime() + 86400000).toISOString(),
          now(),
          row.id,
          expectedSnapshot,
        )
        .run();
    }
  }
  return { inspected: due.results.length };
}
