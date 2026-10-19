import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ArticleVersion, Job, Site } from '../types';
import {
  attachLocalizedVersion,
  availableSlug,
  claimLocalization,
  linkTargets,
  localizationIssues,
  localizationView,
  missingLocales,
  normalizeSlug,
  parseLocalizedOutput,
  prepareSourceContent,
  removeLocalizedVersion,
  type LocalizationRow,
} from './localize';

function fakeDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    create table jobs (
      id text primary key, site_id text not null, status text not null, versions_json text not null default '[]',
      translate_locales_json text, source_locale text not null default '', published_at text,
      en_slug text, en_title text, en_excerpt text, en_content text,
      pt_slug text, pt_title text, pt_excerpt text, pt_content text,
      url_aliases_json text not null default '[]', updated_at text
    );
    create table article_localizations (
      id text primary key, site_id text not null, job_id text not null, locale text not null, status text not null,
      workflow_id text not null default '', error text not null default '', created_at text not null, updated_at text not null
    );
    create unique index article_localizations_job_locale on article_localizations(job_id, locale);
  `);
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
        all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values as never[]).changes) } }),
      }),
    }),
  } as unknown as D1Database;
  return { sqlite, db };
}

const site = { id: 'site-1', source_locale: 'en', translate_locales_json: '["pt-BR","es"]' } as unknown as Site;

const en: ArticleVersion = { locale: 'en', slug: 'study-plan', title: 'Study plan', excerpt: 'How to plan', content: 'Body' };

function job(partial: Partial<Job> = {}): Job {
  return {
    id: 'job-1', site_id: 'site-1', status: 'published', source_locale: 'en', translate_locales_json: '[]',
    versions_json: JSON.stringify([en]), url_aliases_json: '[]', published_at: '2026-09-01T00:00:00.000Z',
    ...partial,
  } as unknown as Job;
}

describe('prepareSourceContent', () => {
  const facts = {
    blogOrigin: 'https://blog.example.com',
    hubUrls: { en: 'https://example.com/en/app', 'pt-BR': 'https://example.com/pt/app' },
    published: [{ job_id: 'job-9', locale: 'en', slug: 'vocab-tips' }],
    referableJobIds: ['job-9', 'job-7'],
  };

  it('keeps article references, outbound sources and images unchanged', () => {
    const content = 'See [tips](article:job-9), [a study](https://journal.org/x) and ![chart](https://cdn.example.com/c.png).';
    expect(prepareSourceContent(content, 'en', 'pt-BR', facts)).toBe(content);
  });

  it('turns a literal blog URL into an article reference, or plain text when no article owns it', () => {
    const content = '[tips](https://blog.example.com/en/blog/vocab-tips) and [gone](/en/blog/deleted-post)';
    expect(prepareSourceContent(content, 'en', 'pt-BR', facts)).toBe('[tips](article:job-9) and gone');
  });

  it('drops references to articles that no longer exist and swaps the hub URL to the target locale', () => {
    const content = '[old](article:job-404) [try it](https://example.com/en/app)';
    expect(prepareSourceContent(content, 'en', 'pt-BR', facts)).toBe('old [try it](https://example.com/pt/app)');
  });
});

describe('localization output checks', () => {
  const output = `<title>Plano de estudos</title>
<slug>Plano de Estudos Rápido</slug>
<excerpt>Como planejar</excerpt>
<meta_description>Descrição</meta_description>
<image_alt></image_alt>
<content>
Veja [dicas](article:job-9) e [um estudo](https://journal.org/x).
</content>`;
  const ok = { ok: true, issues: [] };

  it('parses tagged sections and folds accents in the slug', () => {
    const fields = parseLocalizedOutput(output);
    expect(fields.title).toBe('Plano de estudos');
    expect(fields.content).toBe('Veja [dicas](article:job-9) e [um estudo](https://journal.org/x).');
    expect(normalizeSlug(fields.slug)).toBe('plano-de-estudos-rapido');
  });

  it('accepts a version whose link targets match the source exactly', () => {
    const prepared = 'See [tips](article:job-9) and [a study](https://journal.org/x).';
    expect(localizationIssues(parseLocalizedOutput(output), prepared, ok)).toEqual([]);
  });

  it('rejects added, removed or reordered link targets', () => {
    const fields = parseLocalizedOutput(output);
    expect(localizationIssues(fields, 'See [a study](https://journal.org/x) and [tips](article:job-9).', ok)[0]).toMatch(/same order/);
    expect(localizationIssues(fields, 'Only [tips](article:job-9).', ok)[0]).toMatch(/Not in source/);
    expect(linkTargets('[a](x "title") ![b](y)')).toEqual(['x', 'y']);
  });

  it('surfaces publication QA problems and missing sections', () => {
    const issues = localizationIssues(parseLocalizedOutput('<content>x</content>'), 'x', { ok: false, issues: [{ code: 'q', message: 'bad markdown' }] });
    expect(issues).toEqual(expect.arrayContaining(['The <title> section is missing or empty.', 'bad markdown']));
  });

  it('picks a slug no other article in the locale owns, including former URLs', () => {
    const other = job({ id: 'job-2', versions_json: JSON.stringify([{ ...en, locale: 'pt-BR', slug: 'plano' }]), url_aliases_json: '[{"locale":"pt-BR","slug":"plano-2"}]' });
    expect(availableSlug('plano', 'pt-BR', [other], 'job-1')).toBe('plano-3');
    expect(availableSlug('plano', 'es', [other], 'job-1')).toBe('plano');
  });
});

describe('localization state', () => {
  it('lists the site languages an article lacks and hides languages already running', () => {
    const rows = [
      { job_id: 'job-1', locale: 'pt-BR', status: 'running', error: '', updated_at: new Date().toISOString() },
    ] as LocalizationRow[];
    expect(missingLocales(job(), site)).toEqual(['pt-BR', 'es']);
    expect(localizationView(job(), site, rows)).toMatchObject({ missing_locales: ['es'], items: [{ locale: 'pt-BR', status: 'running' }] });
  });

  it('reports a run that never finished as failed so it can be started again', () => {
    const rows = [{ job_id: 'job-1', locale: 'es', status: 'running', error: '', updated_at: '2026-09-17T00:00:00.000Z' }] as LocalizationRow[];
    const view = localizationView(job(), site, rows, new Date('2026-09-17T01:00:00.000Z'));
    expect(view.items[0].status).toBe('failed');
    expect(view.missing_locales).toEqual(['pt-BR', 'es']);
  });

  it('claims a language once while it runs, and again after it failed', async () => {
    const { db } = fakeDb();
    const now = new Date('2026-09-17T00:00:00.000Z');
    const base = { site_id: 'site-1', job_id: 'job-1', locale: 'es' };
    expect(await claimLocalization(db, { ...base, id: 'a' }, now)).toBe('a');
    expect(await claimLocalization(db, { ...base, id: 'b' }, now)).toBeNull();
    await db.prepare("update article_localizations set status = 'failed' where id = 'a'").bind().run();
    expect(await claimLocalization(db, { ...base, id: 'c' }, now)).toBe('c');
    expect(await claimLocalization(db, { ...base, id: 'd' }, new Date(now.getTime() + 31 * 60_000))).toBe('d');
  });
});

describe('attaching and removing localized versions', () => {
  function insert(sqlite: DatabaseSync, value: Job) {
    sqlite.prepare('insert into jobs (id, site_id, status, versions_json, translate_locales_json, source_locale, published_at, url_aliases_json) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(value.id, value.site_id, value.status, value.versions_json, value.translate_locales_json, value.source_locale ?? '', value.published_at, value.url_aliases_json ?? '[]');
  }
  const pt: ArticleVersion = { locale: 'pt-BR', slug: 'plano', title: 'Plano', excerpt: '', content: 'Corpo' };
  const es: ArticleVersion = { locale: 'es', slug: 'plan', title: 'Plan', excerpt: '', content: 'Cuerpo' };

  it('keeps both languages when two finish at the same time', async () => {
    const { sqlite, db } = fakeDb();
    insert(sqlite, job());
    await Promise.all([attachLocalizedVersion(db, 'job-1', pt), attachLocalizedVersion(db, 'job-1', es)]);
    const row = sqlite.prepare('select versions_json, translate_locales_json, pt_slug from jobs').get() as Record<string, string>;
    expect((JSON.parse(row.versions_json) as ArticleVersion[]).map((v) => v.locale).sort()).toEqual(['en', 'es', 'pt-BR']);
    expect((JSON.parse(row.translate_locales_json) as string[]).sort()).toEqual(['es', 'pt-BR']);
    expect(row.pt_slug).toBe('plano');
  });

  it('never overwrites an existing language or touches an unpublished article', async () => {
    const { sqlite, db } = fakeDb();
    insert(sqlite, job({ versions_json: JSON.stringify([en, pt]) }));
    insert(sqlite, job({ id: 'job-2', status: 'awaiting_review' }));
    expect(await attachLocalizedVersion(db, 'job-1', { ...pt, title: 'Other' })).toBe('exists');
    expect(await attachLocalizedVersion(db, 'job-2', pt)).toBe('not_published');
  });

  it('removes a localized language, keeps its URL reserved, and refuses the source language', async () => {
    const { sqlite, db } = fakeDb();
    const current = job({ versions_json: JSON.stringify([en, pt]), translate_locales_json: '["pt-BR"]' });
    insert(sqlite, current);
    expect(await removeLocalizedVersion(db, current, site, 'en')).toBe('source');
    expect(await removeLocalizedVersion(db, current, site, 'pt-BR')).toBe('removed');
    const row = sqlite.prepare('select versions_json, translate_locales_json, url_aliases_json from jobs').get() as Record<string, string>;
    expect(JSON.parse(row.versions_json)).toEqual([en]);
    expect(JSON.parse(row.translate_locales_json)).toEqual([]);
    expect(JSON.parse(row.url_aliases_json)).toContainEqual({ locale: 'pt-BR', slug: 'plano' });
  });
});
