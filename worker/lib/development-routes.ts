import { sourceLocaleOf } from '../blog/seo';
import { emptyJob, insertJob, newId, publicJob } from '../db';
import { getWorkspaceSite } from './auth/store';
import { seededVersions } from './demo-content';
import { runQa, wordCount } from './qa';
import { jobGenerationLocales } from './webhook';
import { versionsPatch } from './versions';
import type { ArticleVersion } from '../types';

/** Called only after the console's authentication and same-origin mutation checks. */
export async function handleDevelopmentRequest(request: Request, env: Env, workspaceId: string): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || !['/api/dev/mock-ingest', '/api/dev/seed-job'].includes(path)) return null;
  // Synthetic mutations are an installation choice, independent of Agent probes and login mode.
  if (env.DEV_TOOLS_ENABLED !== 'true') return Response.json({ error: 'not found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Response.json({ error: 'body must be an object' }, { status: 400 });
    body = value as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'body must be valid JSON' }, { status: 400 });
  }
  if (path === '/api/dev/mock-ingest') {
    return Response.json({ ok: true, dry_run: body.dry_run === true, received_keys: Object.keys(body) });
  }

  const siteId = typeof body.site_id === 'string' ? body.site_id.trim() : '';
  const site = await getWorkspaceSite(env.DB, workspaceId, siteId);
  if (!site) return Response.json({ error: 'site not found' }, { status: 404 });
  const requestedLocales = Array.isArray(body.translate_locales) ? body.translate_locales.map(String).map(value => value.trim()).filter(Boolean) : [];
  const locales = jobGenerationLocales(
    { translate_locales_json: JSON.stringify(requestedLocales), versions_json: '[]' },
    site,
  );
  const versions = padVersions(seededVersions(locales, site.hub_path), site.min_words);
  const report = runQa({ versions, locales, hub_path: site.hub_path });
  const job = emptyJob({
    id: newId(),
    site_id: siteId,
    status: report.ok ? 'awaiting_review' : 'failed',
    category: 'COMPARISON',
    translate_locales_json: JSON.stringify(locales.filter(locale => locale !== sourceLocaleOf(site))),
    qa_report: JSON.stringify(report),
    ...versionsPatch(versions),
  });
  await insertJob(env.DB, job);
  return Response.json({ job: publicJob(job, locales), qa: report }, { status: 201 });
}

function padVersions(versions: ArticleVersion[], minWords: number): ArticleVersion[] {
  const extra = ' This synthetic paragraph exists only to exercise the configured article layout and export checks.';
  return versions.map((version, index) => {
    let content = version.content;
    const target = index === 0 ? minWords : Math.floor(minWords * 0.6);
    while (wordCount(content) < target) content += extra;
    return { ...version, content };
  });
}
