import { z } from 'zod';
import { getSiteForWorkspace, listJobs, livePath } from '../db';
import { articleUrl } from '../blog/seo';
import { publishedLocalePolicy, publishedVersions } from '../blog/render';
import type { RuntimeAgentEnv } from './env';
import { ToolRegistry } from './tools';

const judgmentSchema = z.string().trim().min(1).max(1000);

export const readPublishedArticlesInputSchema = z.object({
  query: z.string().trim().max(500).optional(),
  locale: z.string().trim().min(1).max(40).optional(),
  limit: z.number().int().min(1).max(5).default(1),
  offset: z.number().int().min(0).optional(),
  judgment_summary: judgmentSchema,
});

const publishedArticleSchema = z.object({
  meta_description: z.string().optional(),
  image_url: z.string().optional(),
  image_alt: z.string().optional(),
  job_id: z.string(),
  locale: z.string(),
  slug: z.string(),
  title: z.string(),
  excerpt: z.string(),
  content: z.string(),
  url: z.string(),
  published_at: z.string(),
});

export const readPublishedArticlesOutputSchema = z.object({
  articles: z.array(publishedArticleSchema),
  total_matches: z.number().int().nonnegative(),
  has_more: z.boolean(),
});

export type ReadPublishedArticlesInput = z.infer<typeof readPublishedArticlesInputSchema>;

export async function readPublishedArticles(
  env: RuntimeAgentEnv,
  input: ReadPublishedArticlesInput,
  context: { workspaceId: string; siteId: string },
): Promise<z.infer<typeof readPublishedArticlesOutputSchema>> {
  const site = await getSiteForWorkspace(env.DB, context.workspaceId, context.siteId);
  if (!site) throw new Error('Site was not found in the current workspace');

  const jobs = await listJobs(env.DB, context.siteId, 'published');
  const policy = publishedLocalePolicy(site, jobs);
  const origin = site.domain && site.domain_status === 'live'
    ? `https://${site.domain}`
    : livePath(site.id);
  const query = input.query?.toLocaleLowerCase() || '';
  const matches = publishedVersions(jobs)
    .filter(({ version }) => !input.locale || version.locale === input.locale)
    .filter(({ version }) => !query || [version.slug, version.title, version.excerpt, version.content]
      .some((value) => value.toLocaleLowerCase().includes(query)))
    .sort((left, right) => (
      (right.job.published_at || right.job.created_at).localeCompare(left.job.published_at || left.job.created_at)
    ));

  return {
    articles: matches.slice(input.offset || 0, (input.offset || 0) + input.limit).map(({ job, version }) => ({
      job_id: job.id,
      locale: version.locale,
      slug: version.slug,
      title: version.title,
      excerpt: version.excerpt,
      meta_description: version.meta_description,
      image_url: version.image_url,
      image_alt: version.image_alt,
      content: version.content,
      url: articleUrl(origin, policy, version.locale, version.slug),
      published_at: job.published_at || job.created_at,
    })),
    total_matches: matches.length,
    has_more: matches.length > (input.offset || 0) + input.limit,
  };
}

export function registerPublishedArticleTools(registry: ToolRegistry, env: RuntimeAgentEnv): ToolRegistry {
  return registry.register({
    name: 'read_published_articles', version: 1,
    description: 'Read full content and the actual blog URL for articles in the current site whose Job status is published. Paginate with offset and limit; when has_more is true, increase offset by the returned article count. Optionally filter by locale or a text query; without filters, returns the newest published articles. Draft, review, publishing, and failed Jobs are never returned.',
    capability: 'read', inputSchema: readPublishedArticlesInputSchema, outputSchema: readPublishedArticlesOutputSchema,
    timeoutMs: 15_000, retryable: true, approval: 'never',
    preserveOutputSize: true,
    execute: async (input, context) => readPublishedArticles(env, input, context),
  });
}
