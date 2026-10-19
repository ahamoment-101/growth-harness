import type { Job, Site } from '../types';
import { missingLocales } from './localize';
import { claimLocalization } from './localize';
import { getJob } from '../db';
import { jobVersions } from './versions';
import { workflowInstanceId } from './workflow-instance-id';

export function publicationLocalizationLocales(job: Job, site: Site): string[] {
  return site.publication_language_mode === 'source_only' ? [] : missingLocales(job, site);
}

/** Durable per-locale dispatch after the source article is published. */
export async function queuePublicationLocalization(env: Env, jobId: string, locale: string): Promise<void> {
  const job = await getJob(env.DB, jobId);
  if (!job || job.status !== 'published' || jobVersions(job).some(version => version.locale.toLowerCase() === locale.toLowerCase())) return;
  const localizationId = `publish-localize:${jobId}:${locale}`;
  const claimed = await claimLocalization(env.DB, { id: localizationId, site_id: job.site_id, job_id: jobId, locale });
  if (!claimed) return;
  const workflowId = workflowInstanceId('localize', localizationId);
  const current = await env.DB.prepare('select workflow_id from article_localizations where id=?').bind(localizationId).first<{workflow_id:string}>();
  if (current?.workflow_id === workflowId) return;
  try {
    await env.LOCALIZE_WORKFLOW.create({ id: workflowId, params: { localizationId, jobId, locale } });
  } catch (error) {
    try {
      const existing = await env.LOCALIZE_WORKFLOW.get(workflowId);
      const state = await existing.status();
      if (!['queued','running','waiting','waitingForPause','paused','complete'].includes(state.status)) throw error;
    } catch { throw error; }
  }
  await env.DB.prepare('update article_localizations set workflow_id=? where id=?').bind(workflowId, localizationId).run();
}
