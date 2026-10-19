import { describe, expect, it, vi } from 'vitest';
import { schemaTestDb } from './schema-test-db';
import { getJob, getSite } from '../db';
import { publicationLocalizationLocales, queuePublicationLocalization } from './publication-language';
import { workflowInstanceId } from './workflow-instance-id';

const versions = JSON.stringify([{ locale: 'en', slug: 'guide', title: 'Guide', excerpt: 'Guide', content: 'Guide' }]);

function fixture() {
  const f = schemaTestDb();
  f.insert('workspaces', { id: 'w', name: 'Workspace' });
  f.insert('sites', { id: 's', workspace_id: 'w', name: 'Site', source_locale: 'en', translate_locales_json: '["pt-BR","es"]' });
  f.insert('jobs', { id: 'j', site_id: 's', status: 'published', source_locale: 'en', versions_json: versions });
  const create = vi.fn(async () => ({ id: 'created' }));
  const env = { DB: f.db, LOCALIZE_WORKFLOW: { create, get: vi.fn(async () => ({ status: async () => ({ status: 'running' }) })) } } as unknown as Env;
  return { ...f, env, create };
}

describe('publication language policy', () => {
  it('defaults to all enabled languages and allows source only', async () => {
    const f = fixture();
    const job = (await getJob(f.db, 'j'))!;
    const site = (await getSite(f.db, 's'))!;
    expect(publicationLocalizationLocales(job, site)).toEqual(['pt-BR', 'es']);
    f.sqlite.prepare("update sites set publication_language_mode='source_only' where id='s'").run();
    expect(publicationLocalizationLocales(job, (await getSite(f.db, 's'))!)).toEqual([]);
  });

  it('starts each missing locale at most once and preserves a durable workflow identity', async () => {
    const f = fixture();
    await queuePublicationLocalization(f.env, 'j', 'pt-BR');
    await queuePublicationLocalization(f.env, 'j', 'pt-BR');
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledWith({ id: workflowInstanceId('localize', 'publish-localize:j:pt-BR'),
      params: { localizationId: 'publish-localize:j:pt-BR', jobId: 'j', locale: 'pt-BR' } });
    expect(f.sqlite.prepare("select count(*) n from article_localizations where job_id='j' and locale='pt-BR'").get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare("select workflow_id from article_localizations where job_id='j' and locale='pt-BR'").get())
      .toEqual({ workflow_id: workflowInstanceId('localize', 'publish-localize:j:pt-BR') });
  });
});
