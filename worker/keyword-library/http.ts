import { z } from 'zod';
import { KeywordLibrary } from './service';
import { scopeSchema } from './contracts';
import { readSearchData } from './search-data';
import { keywordKey } from '../lib/research/dataforseo';
import { ToolContractError } from '../agent-runtime/tool-failure';
import type { LibraryEntryView } from '../../shared/keyword-library';

const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
export async function handleKeywordLibrary(request: Request, db: D1Database, workspaceId?: string): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/sites\/([^/]+)\/keyword-library(?:\/(.*))?$/.exec(url.pathname);
  if (!match) return null;
  if (!workspaceId) return response({ error: 'authentication required' }, 401);
  if (request.method !== 'GET') return response({ error: 'method not allowed' }, 405);
  try {
    const siteId = decodeURIComponent(match[1]);
    const site = await db.prepare('select source_locale,translate_locales_json from sites where workspace_id=? and id=?').bind(workspaceId, siteId).first<{source_locale:string;translate_locales_json:string}>();
    if (!site) return response({ error: 'not found' }, 404);
    const action = match[2] || 'entries';
    const locales = [...new Set([site.source_locale, ...JSON.parse(site.translate_locales_json)])];
    if (action === 'languages') return response({ languages: locales.map(locale => ({ locale })) });
    if (url.searchParams.has('market')) return response({ error: 'market is not a supported parameter; select a configured locale' }, 400);
    const scope = scopeSchema.parse({ workspace_id: workspaceId, site_id: siteId, locale: url.searchParams.get('locale') });
    if (!locales.includes(scope.locale)) return response({ error: 'Language is not configured for this project' }, 400);
    const library = new KeywordLibrary(db, scope);
    const values = [scope.workspace_id, scope.site_id, scope.locale];
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 30;
    const after = url.searchParams.get('after') || undefined;
    if (action === 'entries') {
      const page = await library.list({ kind: url.searchParams.get('kind') || undefined, query: url.searchParams.get('query') || undefined, parent_id: url.searchParams.get('parent_id') || undefined, intent: url.searchParams.get('intent') || undefined, archived: url.searchParams.get('archived') === 'true', after, limit });
      const summaries = page.items.length ? await db.prepare(`select e.id,
        (select json_group_array(json_object('id',p.id,'name',p.name,'kind',p.kind)) from keyword_library_entries p where p.id in (
          select parent_id from keyword_library_memberships where child_id=e.id union
          select a.parent_id from keyword_library_memberships a join keyword_library_memberships b on a.child_id=b.parent_id where b.child_id=e.id
        )) as parents_json,
        (select count(*) from keyword_library_topic_links where keyword_id=e.id) as topic_count,
        (select count(distinct child_id) from (select child_id from keyword_library_memberships where parent_id=e.id and child_kind='keyword' union select b.child_id from keyword_library_memberships a join keyword_library_memberships b on a.child_id=b.parent_id where a.parent_id=e.id and b.child_kind='keyword')) as keyword_count
        from keyword_library_entries e where e.id in (${page.items.map(() => '?').join(',')})`)
        .bind(...page.items.map((entry) => entry.id)).all<{ id: string; parents_json: string; topic_count: number; keyword_count: number }>() : { results: [] };
      const byId = new Map(summaries.results.map((row) => [row.id, row]));
      const searchData = await readSearchData(db, scope, page.items.filter((entry) => entry.kind === 'keyword').map((entry) => entry.name));
      const items: LibraryEntryView[] = page.items.map((entry) => { const row = byId.get(entry.id)!; return { ...entry, parents: JSON.parse(row.parents_json), topic_count: row.topic_count, keyword_count: row.keyword_count,
        ...(entry.kind === 'keyword' ? { search_data: searchData.get(keywordKey(entry.name)) || null } : {}) }; });
      return response({ items, next: page.next });
    }
    if (action.startsWith('entries/')) return response(await library.detail(decodeURIComponent(action.slice(8)), { limit, topic_after: after, membership_after: url.searchParams.has('membership_after') ? JSON.parse(url.searchParams.get('membership_after')!) : undefined }));
    if (action === 'logs') return response(await library.logs({ target_id: url.searchParams.get('target_id') || undefined, actor_type: url.searchParams.get('actor_type') || undefined, before: after ? JSON.parse(after) : undefined, limit }));
    if (action.startsWith('topics/')) {
      z.number().int().min(1).max(100).parse(limit);
      const id = decodeURIComponent(action.slice(7));
      const topic = await db.prepare('select id,title_hint,status,category,primary_keyword,created_at from topics where site_id=? and id=?').bind(siteId, id).first();
      if (!topic) return response({ error: 'Topic does not exist' }, 404);
      const rows = await db.prepare(`select e.id,e.name,l.relationship from keyword_library_topic_links l join keyword_library_entries e on e.id=l.keyword_id where l.workspace_id=? and l.site_id=? and l.locale=? and l.topic_id=? ${after ? 'and e.id>?' : ''} order by e.id limit ?`).bind(...values, id, ...(after ? [after] : []), limit + 1).all<{ id: string; name: string; relationship: string }>();
      const page = rows.results.slice(0, limit);
      const searchData = await readSearchData(db, scope, page.map((keyword) => keyword.name));
      const keywords = page.map((keyword) => ({ ...keyword, search_data: searchData.get(keywordKey(keyword.name)) || null }));
      return response({ topic, keywords, next: rows.results.length > limit ? keywords.at(-1)!.id : null });
    }
    return response({ error: 'not found' }, 404);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError) return response({ error: 'Invalid request parameters' }, 400);
    if (error instanceof ToolContractError) return response({ error: error.message, details: error.details }, error.details.kind === 'state_conflict' ? 409 : 404);
    throw error;
  }
}
