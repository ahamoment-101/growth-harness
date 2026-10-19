import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getJob, getSite, isoNow, listJobs, updateJob, updateSite } from '../db';
import { buildWebhookPosts, webhookExportEnabled } from '../lib/webhook';
import { getAccessToken, gscSubmitSitemap as gscApiSubmitSitemap, submitIndexNow } from '../lib/gsc';
import { jobVersions } from '../lib/versions';
import { articleUrl, persistableLocalePolicy, serializeLocalePolicy } from '../blog/seo';
import { publishedLocalePolicy } from '../blog/render';
import type { PublishParams } from '../types';
import { queuePublicationLocalization } from '../lib/publication-language';

export class PublishWorkflow extends WorkflowEntrypoint<Env, PublishParams> {
  async run(event: WorkflowEvent<PublishParams>, step: WorkflowStep) {
    const jobId = event.payload.jobId;

    await step.do('ensure_public_locale_policy', async () => {
      const job = await getJob(this.env.DB, jobId);
      if (!job) throw new Error('job not found');
      const site = await getSite(this.env.DB, job.site_id);
      if (!site) throw new Error('site not found');
      const requiredLocales = jobVersions(job).map((version) => version.locale);
      await updateSite(this.env.DB, site.id, {
        locale_policy_json: serializeLocalePolicy(persistableLocalePolicy(site, null, requiredLocales)),
      });
      return jobId;
    });

    await step.do('go_live', async () => {
      const job = await getJob(this.env.DB, jobId);
      if (!job) throw new Error('job not found');
      await updateJob(this.env.DB, jobId, {
        status: 'published',
        error: null,
        published_at: job.published_at || new Date().toISOString(),
      });
      return jobId;
    });

    for (const locale of event.payload.localizationLocales || []) {
      await step.do(`localize_${locale}`, async () => {
        await queuePublicationLocalization(this.env, jobId, locale);
        return jobId;
      });
    }

    await step.do('optional_webhook', async () => {
      const job = await getJob(this.env.DB, jobId);
      if (!job) throw new Error('job not found');
      const site = await getSite(this.env.DB, job.site_id);
      if (!site) throw new Error('site not found');
      if (!webhookExportEnabled(site)) return jobId;

      const posts = buildWebhookPosts(site, job);
      const url = absoluteUrl(site.ingest_url);
      const replies: string[] = [];
      for (const payload of posts) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              [site.secret_header || 'x-ingest-secret']: site.ingest_secret,
            },
            body: JSON.stringify(payload),
          });
          const text = await res.text();
          replies.push(`${res.status} ${text.slice(0, 800)}`);
          if (!res.ok) {
            await updateJob(this.env.DB, jobId, {
              error: `webhook ${res.status}: ${text.slice(0, 800)}`,
              publish_response: replies.join('\n').slice(0, 4000),
            });
            return jobId;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await updateJob(this.env.DB, jobId, {
            error: `webhook ${message}`,
            publish_response: replies.join('\n').slice(0, 4000),
          });
          return jobId;
        }
      }

      await updateJob(this.env.DB, jobId, {
        error: null,
        publish_response: replies.join('\n').slice(0, 4000),
      });
      return jobId;
    });

    await step.do('optional_gsc_submit_sitemap', async () => {
      const job = await getJob(this.env.DB, jobId);
      if (!job) throw new Error('job not found');
      const site = await getSite(this.env.DB, job.site_id);
      if (!site) throw new Error('site not found');

      const readyForGsc =
        site.gsc_oauth_status === 'connected' &&
        site.gsc_property_verification_status === 'verified' &&
        site.gsc_refresh_token_cipher &&
        site.domain &&
        site.domain_status === 'live';

      if (readyForGsc) {
        const clientId = this.env.GOOGLE_CLIENT_ID;
        const clientSecret = this.env.GOOGLE_CLIENT_SECRET;
        const cipherKey = this.env.GSC_TOKEN_CIPHER_KEY;
        if (clientId && clientSecret && cipherKey) {
          try {
            const accessToken = await getAccessToken({
              gscRefreshTokenCipher: site.gsc_refresh_token_cipher!,
              clientId,
              clientSecret,
              cipherKey,
            });
            const propertyUrl = site.gsc_property_url_prefix || `https://${site.domain}/`;
            const sitemapUrl = `https://${site.domain}/sitemap.xml`;
            await gscApiSubmitSitemap(propertyUrl, sitemapUrl, accessToken);
            await updateSite(this.env.DB, site.id, {
              gsc_sitemap_submit_status: 'success',
              gsc_sitemap_last_submit_at: isoNow(),
            });
          } catch {
            await updateSite(this.env.DB, site.id, { gsc_sitemap_submit_status: 'error' });
          }
        }
      }

      return jobId;
    });

    // Push to IndexNow (Bing, Yandex)
    await step.do('optional_indexnow', async () => {
      const job = await getJob(this.env.DB, jobId);
      if (!job) return jobId;
      const site = await getSite(this.env.DB, job.site_id);
      if (!site || !site.domain || site.domain_status !== 'live') return jobId;

      const key = this.env.INDEXNOW_KEY;
      if (!key) return jobId;

      const origin = `https://${site.domain}`;
      const policy = publishedLocalePolicy(site, await listJobs(this.env.DB, site.id));
      const versions = jobVersions(job);
      const urls = versions.map((v) => articleUrl(origin, policy, v.locale, v.slug));
      // Also push sitemap URL
      urls.push(`${origin}/sitemap.xml`);
      try { await submitIndexNow({ host: site.domain, key, urls }); } catch { /* best-effort */ }
      return jobId;
    });
  }
}

export function absoluteUrl(ingestUrl: string): string {
  if (ingestUrl.startsWith('http://') || ingestUrl.startsWith('https://')) return ingestUrl;
  throw new Error('ingest_url must be an absolute URL');
}
