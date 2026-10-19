// @ts-ignore Node-only integration test.
import { DatabaseSync } from 'node:sqlite';
// @ts-ignore Node-only integration test.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyJob, getJob, getSite, insertSite, insertJob, updateJob } from '../db';
import { versionsPatch } from '../lib/versions';
import { articleAliases } from './url-history';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const folder = new URL('../../migrations/', import.meta.url);
  for (const name of (readdirSync(folder.pathname) as string[]).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, folder).pathname, 'utf8'));
  }
  sqlite.exec("insert into sites(id,name,ingest_url) values('s','Site',''),('other','Other','');");
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => { args = values; return statement; },
      first: async () => sqlite.prepare(sql).get(...args as never[]) || null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args as never[]) }),
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args as never[]).changes) } }),
    };
    return statement;
  };
  return { sqlite, db: { prepare } as unknown as D1Database };
}
const version = (slug: string, locale = 'en') => ({ locale, slug, title: 'Article', excerpt: 'Summary', content: 'Body' });

// Real migration + real SQL + application writes, including writes bypassing updateJob.
describe('durable public URL ownership', () => {
  it('creates a site with its full SEO and language configuration', async () => {
    const { db, sqlite } = database();
    try {
      const source = (await getSite(db, 's'))!;
      await insertSite(db, { ...source, id: 'new-site', root_domain: 'new.example', seo_identity_json: '{"defaultOgImage":"https://example.com/cover.png"}' });
      expect((await getSite(db, 'new-site'))?.seo_identity_json).toContain('cover.png');
    } finally { sqlite.close(); }
  });

  it('keeps redirect history through multiple edits and direct lifecycle writes', async () => {
    const { db, sqlite } = database();
    try {
      await insertJob(db, emptyJob({ id: 'j', site_id: 's', status: 'published', published_at: '2026-09-01', ...versionsPatch([version('first')]) }));
      await updateJob(db, 'j', versionsPatch([version('second')]));
      await updateJob(db, 'j', versionsPatch([version('third')]));
      expect(articleAliases((await getJob(db, 'j'))!).map((v) => v.slug)).toEqual(expect.arrayContaining(['first', 'second']));
      sqlite.prepare('update jobs set versions_json = ? where id = ?').run(JSON.stringify([version('fourth')]), 'j');
      expect(articleAliases((await getJob(db, 'j'))!).map((v) => v.slug)).toEqual(expect.arrayContaining(['first', 'second', 'third']));
      expect((await getJob(db, 'j'))?.published_at).toBe('2026-09-01');
    } finally { sqlite.close(); }
  });

  it('atomically rejects another owner for current or historical URLs while keeping locale and site boundaries', async () => {
    const { db, sqlite } = database();
    try {
      const original = emptyJob({ id: 'a', site_id: 's', status: 'published', published_at: '2026-09-01', ...versionsPatch([version('old')]) });
      await insertJob(db, original);
      await updateJob(db, 'a', versionsPatch([version('current')]));
      for (const slug of ['old', 'current']) {
        await expect(insertJob(db, emptyJob({ id: `conflict-${slug}`, site_id: 's', ...versionsPatch([version(slug)]) }))).rejects.toThrow('reserved');
      }
      await insertJob(db, emptyJob({ id: 'b', site_id: 's', ...versionsPatch([version('different')]) }));
      await expect(updateJob(db, 'b', versionsPatch([version('old')]))).rejects.toThrow('reserved');
      expect((await getJob(db, 'b'))?.en_slug).toBe('different');
      await insertJob(db, emptyJob({ id: 'other-locale', site_id: 's', ...versionsPatch([version('old', 'fr')]) }));
      await insertJob(db, emptyJob({ id: 'other-site', site_id: 'other', ...versionsPatch([version('old')]) }));
    } finally { sqlite.close(); }
  });
});
