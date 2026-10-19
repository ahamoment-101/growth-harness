// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { readPublishedArticles } from './published-article-tools';

function fixtureDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    create table sites (
      id text primary key, workspace_id text not null, domain text not null, domain_status text not null,
      locale_policy_json text not null, source_locale text not null, translate_locales_json text not null
    );
    create table jobs (
      id text primary key, site_id text not null, status text not null, versions_json text not null,
      en_slug text, en_title text, en_excerpt text, en_content text,
      pt_slug text, pt_title text, pt_excerpt text, pt_content text,
      published_at text, created_at text not null
    );
    insert into sites values (
      'site-1', 'workspace-1', 'blog.example.com', 'live',
      '{"defaultCode":"en","locales":[{"code":"en","prefix":"en"},{"code":"pt-BR","prefix":"pt"}],"redirects":[]}',
      'en', '[]'
    );
    insert into jobs values
      ('published-1', 'site-1', 'published', '[{"locale":"en","slug":"memory-guide","title":"Memory guide","excerpt":"Recall","content":"Full published body"},{"locale":"pt-BR","slug":"guia-memoria","title":"Guia de memoria","excerpt":"Recordacao","content":"Conteudo publicado"}]', null, null, null, null, null, null, null, null, '2026-09-02T08:00:00Z', '2026-09-02T07:00:00Z'),
      ('draft-1', 'site-1', 'awaiting_review', '[{"locale":"en","slug":"private-draft","title":"Private draft","excerpt":"Hidden","content":"Never expose this"}]', null, null, null, null, null, null, null, null, null, '2026-09-02T09:00:00Z');
  `);
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind: (...next: unknown[]) => { values = next; return statement; },
      first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
    };
    return statement;
  };
  return { DB: { prepare } } as never;
}

describe('read_published_articles', () => {
  it('returns full content and locale-aware live URLs only for rendered published Jobs', async () => {
    const result = await readPublishedArticles(fixtureDb(), {
      query: 'publicado', locale: 'pt-BR', limit: 3, judgment_summary: 'Read existing live coverage.',
    }, { workspaceId: 'workspace-1', siteId: 'site-1' });

    expect(result).toEqual({
      articles: [{
        job_id: 'published-1', locale: 'pt-BR', slug: 'guia-memoria', title: 'Guia de memoria',
        excerpt: 'Recordacao', content: 'Conteudo publicado',
        url: 'https://blog.example.com/pt/blog/guia-memoria', published_at: '2026-09-02T08:00:00Z',
      }],
      total_matches: 1,
      has_more: false,
    });
  });

  it('does not expose non-published content and enforces the workspace boundary', async () => {
    await expect(readPublishedArticles(fixtureDb(), {
      query: 'Never expose', limit: 3, judgment_summary: 'Check hidden content.',
    }, { workspaceId: 'workspace-1', siteId: 'site-1' })).resolves.toMatchObject({ articles: [], total_matches: 0 });
    await expect(readPublishedArticles(fixtureDb(), {
      limit: 3, judgment_summary: 'Attempt another workspace.',
    }, { workspaceId: 'workspace-2', siteId: 'site-1' })).rejects.toThrow('current workspace');
  });
});

it('paginates published coverage without repeating the first page', async () => {
  const env = fixtureDb();
  const context = { workspaceId: 'workspace-1', siteId: 'site-1' };
  const first = await readPublishedArticles(env, { limit: 1, offset: 0, judgment_summary: 'Inspect coverage' }, context);
  const second = await readPublishedArticles(env, { limit: 1, offset: 1, judgment_summary: 'Continue coverage' }, context);
  expect(first.has_more).toBe(true);
  expect(second.has_more).toBe(false);
  expect(second.articles[0].locale).not.toBe(first.articles[0].locale);
});
