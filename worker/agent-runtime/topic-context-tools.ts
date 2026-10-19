import { z } from 'zod';
import { latestGscQueries } from '../lib/research/store';
import { listBusinessModules } from '../lib/business';
import { topicScope, type TopicScope } from './topic-scope';
import type { AgentRun } from './protocol';
import type { ToolRegistry } from './tools';

/** Domain observations are called by the Agent, never scheduled by Runtime. */
export function registerTopicContextTool(registry: ToolRegistry, db: D1Database, binding?: { workspaceId: string; siteId: string; run: AgentRun }) {
  return registry.register({
    name: 'read_topic_context', version: 1, capability: 'read', approval: 'never', retryable: false, timeoutMs: 15000,
    description: 'Read business document provenance, strategy recommendations (not keyword candidates or human authorization), prior topic decisions, or topic/article inventory for the task language. History and inventory paginate by offset. Strategy recommendations may be revised by your judgment. Inventory includes draft topics and article states; select read_published_articles to read article content.',
    inputSchema: z.object({ section: z.enum(['business', 'strategy', 'history', 'inventory', 'performance']), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }),
    outputSchema: z.unknown(), preserveOutputSize: true,
    execute: async args => {
      if (!binding) throw new Error('Topic context requires an active task');
      const scope = topicScope(binding.run.summary_json);
      if (!scope) throw new Error('This task has no language binding');
      return readTopicContext(db, binding.workspaceId, binding.siteId, scope, args);
    },
  });
}
export async function readTopicContext(db: D1Database, workspaceId: string, siteId: string, scope: TopicScope, args: { section: string; offset: number; limit: number }) {
  if (!await db.prepare('select id from sites where id=? and workspace_id=?').bind(siteId, workspaceId).first()) throw new Error('Site not found');
  if (args.section === 'performance') return { scope, provenance: 'Site-wide GSC observations. Do not infer this language or market attribution unless the evidence explicitly supports it.', observations: await latestGscQueries(db, siteId) };
  if (args.section === 'business') return { scope, modules: await listBusinessModules(db, siteId), provenance_note: 'source identifies how each document was saved; a human-edited document is not automatically a blanket ban. Attribute explicit user constraints separately from AI recommendations.' };
  if (args.section === 'strategy') {
    const rows = await db.prepare(`select v.id, v.locale_version as version, v.source_locale as locale, v.created_at,
      v.change_summary, d.doc_type, d.body_md from seo_strategy_versions v join seo_strategy_documents d on d.strategy_version_id=v.id
      where v.site_id=? and v.status='active' and v.source_locale=? and d.doc_type in ('strategy','research_notes') order by d.doc_type`).bind(siteId, scope.locale).all();
    return { scope, provenance: 'AI strategy recommendation; market applicability must be assessed from the document', documents: rows.results, keyword_source: 'keyword_library_only' };
  }
  const rows = args.section === 'history'
    ? await db.prepare(`select r.*,s.status as research_task_status,s.outcome as research_task_outcome,s.reason as research_task_reason
      from topic_decision_results r left join agent_tasks s on r.research_run_id!='' and s.id=r.research_run_id where r.workspace_id=? and r.site_id=? and
      r.scope_locale=?
      order by r.created_at desc,r.id desc limit ? offset ?`).bind(workspaceId, siteId, scope.locale, args.limit + 1, args.offset).all()
    : await db.prepare(`select t.id as topic_id,t.title_hint,t.primary_keyword,t.status as topic_status,i.locale,i.relationship_to_existing,
        j.id as job_id,j.status as job_status,j.published_at,
        coalesce(r.scope_locale,json_extract(t.plan_json,'$.locale')) as scope_locale
      from topics t left join topic_decision_items i on i.id=t.decision_item_id
      left join topic_decision_results r on r.id=i.result_id left join jobs j on j.topic_id=t.id
      where t.site_id=? and coalesce(r.scope_locale,json_extract(t.plan_json,'$.locale'))=?
      order by t.created_at desc,t.id desc,j.id desc limit ? offset ?`).bind(siteId, scope.locale, args.limit + 1, args.offset).all();
  const outcomes = args.section === 'history' ? (await db.prepare(`select id,status,output_json,created_at,summary_json from agent_runs where workspace_id=? and site_id=? and agent_id='topic_decision' and status in ('succeeded','failed','cancelled') and
    json_extract(summary_json,'$.scope.locale')=?
    order by created_at desc,id desc limit ? offset ?`).bind(workspaceId, siteId, scope.locale, args.limit + 1, args.offset).all()).results : [];
  const items = rows.results.slice(0, args.limit) as Array<Record<string, unknown>>;
  // A topic may already cover library keywords beyond its primary keyword; show them where coverage is judged.
  if (args.section === 'inventory' && items.length) {
    const topicIds = [...new Set(items.map(item => String(item.topic_id)))];
    const links = await db.prepare(`select l.topic_id,e.name as keyword,l.relationship from keyword_library_topic_links l join keyword_library_entries e on e.id=l.keyword_id
      where l.workspace_id=? and l.site_id=? and l.topic_id in (${topicIds.map(() => '?').join(',')}) order by e.name`)
      .bind(workspaceId, siteId, ...topicIds).all<{ topic_id: string; keyword: string; relationship: string }>();
    for (const item of items) item.linked_keywords = links.results.filter(link => link.topic_id === item.topic_id).map(({ keyword, relationship }) => ({ keyword, relationship }));
  }
  return { scope, items, prior_outcomes: outcomes.slice(0, args.limit), next_offset: Math.max(rows.results.length, outcomes.length) > args.limit ? args.offset + args.limit : null };
}
