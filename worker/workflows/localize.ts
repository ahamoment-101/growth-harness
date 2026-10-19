import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getJob, getSite, listJobs, updateSite } from '../db';
import { articleUrl, persistableLocalePolicy, serializeLocalePolicy } from '../blog/seo';
import { publishedLocalePolicy } from '../blog/render';
import { buildBusinessContext, listBusinessModules } from '../lib/business';
import { submitIndexNow } from '../lib/gsc';
import { siteLinkFacts } from '../lib/qa';
import { jobVersions } from '../lib/versions';
import { publicationQa } from '../agent-runtime/content-production';
import { resolveModelProfile } from '../agent-runtime/model-registry';
import {
  LocalizationRejected,
  attachLocalizedVersion,
  availableSlug,
  localizationIssues,
  localizationMessages,
  localizedVersion,
  normalizeSlug,
  parseLocalizedOutput,
  prepareSourceContent,
  requestLocalization,
  setLocalizationStatus,
  sourceVersionOf,
  type ChatMessage,
} from '../lib/localize';
import type { ArticleVersion } from '../types';

export type LocalizeParams = { localizationId: string; jobId: string; locale: string };

/** One repair round: the model sees exactly what failed and fixes it once. */
const GENERATION_ATTEMPTS = 2;

export class LocalizeWorkflow extends WorkflowEntrypoint<Env, LocalizeParams> {
  async run(event: WorkflowEvent<LocalizeParams>, step: WorkflowStep) {
    const { localizationId, jobId, locale } = event.payload;
    let rejection = '';
    try {
      // A rejection is a completed step, not a thrown one, so the step does not
      // retry a result that another identical attempt would not change.
      const generated = await step.do(
        'generate',
        { retries: { limit: 2, delay: '1 minute', backoff: 'exponential' }, timeout: '15 minutes' },
        async (): Promise<{ version: ArticleVersion } | { rejected: string }> => {
          try {
            return { version: await generate(this.env, jobId, locale) };
          } catch (error) {
            if (error instanceof LocalizationRejected) return { rejected: error.message };
            throw error;
          }
        },
      );
      if ('rejected' in generated) {
        rejection = generated.rejected;
      } else {
        rejection = await step.do('go_live', async () => {
          const job = await getJob(this.env.DB, jobId);
          const site = job ? await getSite(this.env.DB, job.site_id) : null;
          if (!job || !site) return 'Article or site no longer exists';
          await updateSite(this.env.DB, site.id, {
            locale_policy_json: serializeLocalePolicy(persistableLocalePolicy(site, null, [locale])),
          });
          const outcome = await attachLocalizedVersion(this.env.DB, jobId, generated.version);
          if (outcome === 'not_published') return 'Article is no longer in published state; language version not launched';
          if (outcome === 'exists') return 'Article already has a version in this language; not overwritten';
          await setLocalizationStatus(this.env.DB, localizationId, 'done');
          return '';
        });
      }
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    if (rejection) {
      await step.do('record_failure', async () => {
        await setLocalizationStatus(this.env.DB, localizationId, 'failed', rejection);
        return localizationId;
      });
      return;
    }

    await step.do('optional_indexnow', async () => {
      const job = await getJob(this.env.DB, jobId);
      const site = job ? await getSite(this.env.DB, job.site_id) : null;
      const key = this.env.INDEXNOW_KEY;
      if (!job || !site || !site.domain || site.domain_status !== 'live' || !key) return jobId;
      const origin = `https://${site.domain}`;
      const policy = publishedLocalePolicy(site, await listJobs(this.env.DB, site.id));
      const added = jobVersions(job).find((candidate) => candidate.locale === locale);
      if (!added) return jobId;
      try {
        await submitIndexNow({ host: site.domain, key, urls: [articleUrl(origin, policy, locale, added.slug), `${origin}/sitemap.xml`] });
      } catch { /* best-effort */ }
      return jobId;
    });
  }
}

async function generate(env: Env, jobId: string, locale: string): Promise<ArticleVersion> {
  const job = await getJob(env.DB, jobId);
  if (!job || job.status !== 'published') throw new LocalizationRejected('Article is no longer in published state');
  const site = await getSite(env.DB, job.site_id);
  if (!site) throw new LocalizationRejected('Site no longer exists');
  const source = sourceVersionOf(job, site);
  if (!source) throw new LocalizationRejected('The article has no available original version');
  if (jobVersions(job).some((existing) => existing.locale.toLowerCase() === locale.toLowerCase())) {
    throw new LocalizationRejected('Article already has a version in this language');
  }

  const jobs = await listJobs(env.DB, site.id);
  const facts = siteLinkFacts(site as unknown as Record<string, unknown>);
  const published = jobs
    .filter((candidate) => candidate.status === 'published')
    .flatMap((candidate) => jobVersions(candidate).map((v) => ({ job_id: candidate.id, locale: v.locale, slug: v.slug })));
  const preparedContent = prepareSourceContent(source.content, source.locale, locale, {
    blogOrigin: facts.blog_origin,
    hubUrls: facts.hub_urls,
    published,
    referableJobIds: jobs
      .filter((candidate) => candidate.id !== job.id && (candidate.status === 'published'
        || (!!job.production_group_id && candidate.production_group_id === job.production_group_id)))
      .map((candidate) => candidate.id),
  });
  const businessContext = buildBusinessContext(await listBusinessModules(env.DB, site.id));
  const profile = resolveModelProfile(env, 'article_production');

  const messages: ChatMessage[] = localizationMessages({ source, preparedContent, targetLocale: locale, businessContext });
  let issues: string[] = [];
  for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt++) {
    const output = await requestLocalization(profile, messages);
    const fields = parseLocalizedOutput(output);
    const slug = availableSlug(normalizeSlug(fields.slug), locale, jobs, job.id);
    const version = localizedVersion(fields, source, locale, slug);
    const qa = await publicationQa(env.DB, site as unknown as Record<string, unknown>, job, [version], [locale]);
    issues = localizationIssues(fields, preparedContent, qa);
    if (!issues.length) return version;
    messages.push(
      { role: 'assistant', content: output },
      { role: 'user', content: `Fix these problems and reply with the complete corrected sections again:\n- ${issues.join('\n- ')}` },
    );
  }
  throw new LocalizationRejected(`Localization result failed checks: ${issues.join('; ')}`);
}
