import { getJob, getSite, updateJob } from '../db';
import { persistableLocalePolicy } from '../blog/seo';
import { jobVersions } from './versions';
import { publicationLocalizationLocales } from './publication-language';
import { workflowInstanceId } from './workflow-instance-id';

export async function startPublish(env: Env, jobId: string, expected?: { artifactId: string; versionsJson: string; operationId?: string; localizationLocales?: string[] }): Promise<void> {
  const job = await getJob(env.DB, jobId);
  if (!job) throw new Error('job not found');
  const operationId = expected?.operationId;
  const workflowId = operationId ? workflowInstanceId('publish', operationId) : '';
  const resuming = Boolean(operationId && job.publication_operation_id === operationId && job.workflow_id === workflowId && job.status === 'publishing');
  if (!resuming && job.status !== 'awaiting_review') throw new Error('job is no longer awaiting_review');
  const site = await getSite(env.DB, job.site_id);
  if (!site) throw new Error('site not found');
  persistableLocalePolicy(site, null, jobVersions(job).map((version) => version.locale));
  const localizationLocales = resuming && job.publication_locales_json
    ? JSON.parse(job.publication_locales_json) as string[]
    : expected?.localizationLocales ?? publicationLocalizationLocales(job, site);
  if (!resuming) {
    const transition = await env.DB.prepare(
      `update jobs set status = 'publishing', publication_operation_id = ?, publication_locales_json = ?, workflow_id = ?, error = '', updated_at = ? where id = ? and status = 'awaiting_review'
        and (? = '' or (current_artifact_id = ? and versions_json = ?))`,
    ).bind(operationId || '', JSON.stringify(localizationLocales), workflowId, new Date().toISOString(), jobId, expected?.artifactId || '', expected?.artifactId || '', expected?.versionsJson || '').run();
    if (!transition.meta.changes) throw new Error('job is no longer awaiting_review');
  }
  try {
    const params = localizationLocales.length ? { jobId, localizationLocales } : { jobId };
    const instance = await env.PUBLISH_WORKFLOW.create(workflowId ? { id: workflowId, params } : { params });
    if (!workflowId) await updateJob(env.DB, jobId, { workflow_id: instance.id });
  } catch (error) {
    if (workflowId) {
      try {
        const instance = await env.PUBLISH_WORKFLOW.get(workflowId);
        const state = await instance.status();
        if (['queued','running','waiting','waitingForPause','paused','complete'].includes(state.status)) return;
      } catch { /* Keep the durable identity when the effect is uncertain. */ }
      throw error;
    }
    await env.DB.prepare(
      "update jobs set status = 'awaiting_review', publication_operation_id = '', error = ?, updated_at = ? where id = ? and status = 'publishing' and workflow_id = ''",
    ).bind(error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000), new Date().toISOString(), jobId).run();
    throw error;
  }
}
