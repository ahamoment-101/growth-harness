import { readRuntimeJson } from './runtime-content';
import { resultForTask } from './research-contract';
import { z } from 'zod';
import { getSiteForWorkspace, listJobs, livePath } from '../db';
import { publishedLocalePolicy, publishedVersions } from '../blog/render';
import { articleUrl } from '../blog/seo';
import { jobVersions } from '../lib/versions';
import { activeStrategyVersion } from '../lib/research/strategy-store';
import { readSource, readSourcePage, sourceIndex, sourceReference } from '../lib/research/evidence';
import { sourceTextPage } from '../lib/research/source-pages';
import type { RuntimeAgentEnv } from './env';
import type { ToolRegistry } from './tools';
import { requireTask, taskDataJson, type AgentTask } from './task-store';
import { ToolContractError } from './tool-failure';
import { researchPageTool } from './research-page-tool';

const offsetSchema = z.number().int().nonnegative().default(0);
// Relationships are expressed by names; storage ids and keys stay out of historical reads.
const historicalStructureQueries = {
  territories: 'select name,priority_band,status,audience_summary,search_job_summary,business_goal,conversion_goal,summary from seo_topic_territories where strategy_version_id = ? order by sort_order,id',
  clusters: `select t.name as territory_name,c.name,c.priority_band,c.status,c.strategic_role,c.recommended_hub,c.conversion_goal,c.summary
    from seo_keyword_clusters c join seo_topic_territories t on t.id = c.territory_id where c.strategy_version_id = ? order by t.sort_order,c.sort_order,c.id`,
  keywords: `select k.term,k.locale,c.name as cluster_name,sk.intent,sk.journey_stage,sk.serp_shape,sk.recommended_page_type,sk.business_relevance,sk.conversion_route,
    sk.priority_band,sk.priority_rationale,sk.coverage_status,sk.decision,sk.existing_url,sk.evidence_summary
    from seo_strategy_keywords sk join seo_keywords k on k.id = sk.keyword_id join seo_keyword_clusters c on c.id = sk.cluster_id where sk.strategy_version_id = ? order by sk.id`,
};
const page = (content: string, offset: number) => ({ excerpt: content.slice(offset, offset + 16000),
  next_offset: offset + 16000 < content.length ? offset + 16000 : null, total_characters: content.length, offset_unit: 'characters' });
function missing(message: string): never {
  throw new ToolContractError(message, { kind: 'invalid_request', effects: 'none', issues: [], guidance: 'Read the available identities for this task and choose an authorized resource.' });
}

export async function strategyInitialContext(env: RuntimeAgentEnv, task: AgentTask): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare('select context_json from agent_conversations where task_id = ?').bind(task.id).first<{ context_json: string }>();
  return row ? (await readRuntimeJson<Record<string, any>>(env.DB, row.context_json)) : null;
}

/** historicalReference (strategy v36+): prior versions return content without storage identities, so nothing read here can be mistaken for a draft write selector. */
export function registerStrategyObservationTools(registry: ToolRegistry, env: RuntimeAgentEnv, locale: string, contract = 1, historicalReference = false): void {
  const common = { version: 1, capability: 'read' as const, timeoutMs: 15000, retryable: true, approval: 'never' as const, preserveOutputSize: true };
  registry.register(researchPageTool(env, 'read_web_page', contract === 2));
  registry.register({ ...common, name: 'read_site_content',
    description: 'Inspect this site content inventory in the task locale, including drafts and published assets. Empty job_id lists matching assets; job_id reads one full article in pages. Only actually public articles have a public URL. Indexing, traffic and conversions are not inferred from publication status.',
    inputSchema: z.object({ query: z.string().max(500).default(''), job_id: z.string().default(''), offset: offsetSchema }), outputSchema: z.unknown(),
    execute: async (args, context) => {
      const site = await getSiteForWorkspace(env.DB, context.workspaceId, context.siteId);
      if (!site) missing('Site is not available in this workspace');
      const jobs = await listJobs(env.DB, site.id);
      const published = new Map(publishedVersions(jobs).filter(row => row.version.locale === locale).map(row => [row.job.id, row]));
      const policy = publishedLocalePolicy(site, jobs);
      const origin = site.domain && site.domain_status === 'live' ? `https://${site.domain}` : livePath(site.id);
      const matches = jobs.flatMap(job => {
        const version = jobVersions(job).find(v => v.locale === locale);
        if (!version) return [];
        const isPublic = published.has(job.id);
        return [{ job_id: job.id, locale, status: job.status, publicly_visible: isPublic, title: version.title, slug: version.slug,
          excerpt: version.excerpt, content: version.content, updated_at: job.content_updated_at || job.updated_at,
          published_at: isPublic ? job.published_at || job.created_at : null,
          url: isPublic ? articleUrl(origin, policy, locale, version.slug) : null }];
      }).filter(row => !args.query || [row.title, row.slug, row.excerpt, row.content].some(text => text.toLocaleLowerCase().includes(args.query.toLocaleLowerCase())));
      if (args.job_id) {
        const row = matches.find(item => item.job_id === args.job_id);
        if (!row) missing('Content is not available in this task locale');
        const { content, ...metadata } = row;
        return { ...metadata, ...page(content, args.offset), indexing: 'unknown', traffic: 'not_in_this_source' };
      }
      return { locale, scope: 'stored_article_assets', unavailable: ['external_site_pages', 'indexing_audit', 'conversion_attribution'],
        items: matches.slice(args.offset, args.offset + 30).map(({ content: _content, ...row }) => row),
        total_matches: matches.length, next_offset: args.offset + 30 < matches.length ? args.offset + 30 : null, offset_unit: 'records' };
    },
  });
  registry.register({ ...common, name: 'read_strategy',
    description: 'Read same-locale strategy version identities, full documents or stable structured relationships. Empty version_id selects the strategy captured at task start. Versions remain immutable; use the versions section to explicitly choose another historical version. The sources section lists historical evidence; set source_id to read its complete saved observation in pages. Historical evidence is not automatically fresh.' + (historicalReference ? ' Every version read here, including the captured base, is read-only historical reference: it is not this task draft and nothing returned selects or edits draft objects. To carry content forward, create it in the draft through the blueprint tools.' : ''),
    inputSchema: z.object({ version_id: z.string().default(''), source_id: z.string().default(''), section: z.enum(['versions', 'strategy', 'keyword_map', 'research_notes', 'territories', 'clusters', 'keywords', 'sources']).default('versions'), offset: offsetSchema }), outputSchema: z.unknown(),
    execute: async (args, context) => {
      const task = await requireTask(env.DB, context.runId);
      if (args.section === 'versions') {
        const rows = await env.DB.prepare(`select id,locale_version as version,status,change_summary,business_snapshot_json,created_at from seo_strategy_versions
          where site_id = ? and source_locale = ? and status != 'draft' order by locale_version desc limit 31 offset ?`)
          .bind(task.site_id, locale, args.offset).all();
        return { locale, items: rows.results.slice(0, 30), next_offset: rows.results.length > 30 ? args.offset + 30 : null, offset_unit: 'records' };
      }
      const initial = await strategyInitialContext(env, task);
      const id = args.version_id || (initial ? String(initial.base_strategy_version_id || '') : (await activeStrategyVersion(env.DB, task.site_id, locale))?.id || '');
      if (!id) return { locale, available: false, reason: 'No strategy existed at task start' };
      const version = await env.DB.prepare(`select id,locale_version as version,status,business_snapshot_json,created_at from seo_strategy_versions
        where id = ? and site_id = ? and source_locale = ? and status != 'draft'`).bind(id, task.site_id, locale).first();
      if (!version) missing('Strategy version is not available in this task locale');
      if (['strategy', 'keyword_map', 'research_notes'].includes(args.section)) {
        const document = await env.DB.prepare('select body_md,content_hash from seo_strategy_documents where strategy_version_id = ? and doc_type = ?')
          .bind(id, args.section).first<{ body_md: string; content_hash: string }>();
        return document ? { locale, version, ...(historicalReference ? { access: 'read_only_historical_version' } : {}), content_hash: document.content_hash, ...page(document.body_md, args.offset) }
          : { locale, version, available: false, reason: 'Document is currently missing for this version; this does not establish whether it was previously saved.' };
      }
      if (args.section === 'sources' && args.source_id) {
        const source = await env.DB.prepare('select id,url,title,query,locale,observed_at,observation_md from seo_research_sources where strategy_version_id = ? and id = ?')
          .bind(id, args.source_id).first<{ id: string; url: string; title: string; observation_md: string }>();
        if (!source) missing('Source is not available in this strategy version');
        const { observation_md, ...metadata } = source;
        return { locale, version, source: metadata, ...page(observation_md, args.offset), freshness: 'not_reverified' };
      }
      const query = args.section === 'sources'
        ? 'select id,url,title,query,locale,observed_at,substr(observation_md,1,1000) as observation_excerpt,length(observation_md) as observation_characters from seo_research_sources where strategy_version_id = ? order by id'
        : historicalReference ? historicalStructureQueries[args.section as keyof typeof historicalStructureQueries]
        : args.section === 'keywords'
        ? `select sk.*,k.term,k.locale from seo_strategy_keywords sk join seo_keywords k on k.id = sk.keyword_id where sk.strategy_version_id = ? order by sk.id`
        : args.section === 'clusters'
          ? 'select * from seo_keyword_clusters where strategy_version_id = ? order by id'
          : 'select * from seo_topic_territories where strategy_version_id = ? order by id';
      const rows = await env.DB.prepare(`${query} limit 31 offset ?`).bind(id, args.offset).all();
      return { locale, version, ...(historicalReference ? { access: 'read_only_historical_version' } : {}),
        items: rows.results.slice(0, 30), next_offset: rows.results.length > 30 ? args.offset + 30 : null, offset_unit: 'records' };
    },
  });
  registry.register({ ...common, name: 'read_evidence',
    ...(contract === 2 ? { version: 2 } : {}),
    description: 'Read saved research and source evidence for this site. Index lists historical research with original locale attribution. Report reads an authorized research task; source reads an exact immutable snapshot. Cross-market evidence retains its original locale and is not automatically local evidence.' + (contract === 2 ? ' Source with empty source_id lists source metadata in record pages; select a returned ID for character pages. Report pages contain the full saved result, including report-only qualifications.' : ''),
    inputSchema: z.object({ section: z.enum(['index', 'report', 'source']).default('index'), research_task_id: z.string().default(''), source_id: z.string().default(''), offset: offsetSchema }), outputSchema: z.unknown(),
    execute: async (args, context) => {
      const task = await requireTask(env.DB, context.runId);
      if (args.section === 'index') {
        const rows = await env.DB.prepare(`select id,status,outcome,reason,json_extract(goal_json,'$.locale') as locale,created_at,updated_at,
          json_extract(goal_json,'$.research_question') as question from agent_tasks where workspace_id = ? and site_id = ? and agent_id = 'deep_research'
          order by created_at desc,id desc limit 31 offset ?`).bind(task.workspace_id, task.site_id, args.offset).all();
        return { target_locale: locale, research: rows.results.slice(0, 30), own_sources: (await sourceIndex(env, task.id)).map(sourceReference),
          next_offset: rows.results.length > 30 ? args.offset + 30 : null, offset_unit: 'records' };
      }
      const selected = !args.research_task_id || args.research_task_id === task.id ? task
        : await env.DB.prepare(`select * from agent_tasks where id = ? and workspace_id = ? and site_id = ? and agent_id = 'deep_research'`)
          .bind(args.research_task_id, task.workspace_id, task.site_id).first<AgentTask>();
      if (!selected) missing('Research is not available in this site');
      const evidenceLocale = String(JSON.parse(selected.goal_json).locale || locale);
      const attribution = { research_task_id: selected.id, locale: evidenceLocale, target_locale: locale,
        scope: evidenceLocale === locale ? 'target_market' : 'cross_market' };
      if (args.section === 'source') {
        const saved = await readRuntimeJson<{ sources?: Array<{ id: string; evidence_type?: string; excerpt?: string }> }>(env.DB, selected.output_json);
        if (contract === 2 && !args.source_id) {
          const rows = [...(saved.sources || []).map(({ excerpt: _excerpt, ...source }) => source),
            ...(await sourceIndex(env, selected.id)).map(sourceReference)];
          return { ...attribution, sources: rows.slice(args.offset, args.offset + 30), total_sources: rows.length,
            next_offset: args.offset + 30 < rows.length ? args.offset + 30 : null, offset_unit: 'records' };
        }
        const supplied = (saved.sources || []).find(source => source.id === args.source_id && source.evidence_type === 'provider_excerpt');
        if (contract === 2 && supplied) {
          const { excerpt, ...metadata } = supplied;
          return { ...attribution, source: metadata, evidence_type: 'provider_excerpt', independently_verified: false,
            ...sourceTextPage(excerpt || '', args.offset), total_characters: (excerpt || '').length, offset_unit: 'characters' };
        }
        if (supplied) return { ...attribution, source: supplied, evidence_type: 'provider_excerpt', independently_verified: false, ...page(supplied.excerpt || '', args.offset) };
        if (contract === 2) return { ...attribution, ...await readSourcePage(env, selected, args.source_id, args.offset) };
        const source = await readSource(env, selected, args.source_id);
        return { ...attribution, source: source.source, ...page(source.content, args.offset) };
      }
      if (selected.agent_id !== 'deep_research') missing('Choose a deep research task from the index');
      const report = await resultForTask(env, selected);
      return { ...attribution, status: selected.status, outcome: selected.outcome, updated_at: selected.updated_at,
        ...(contract === 2 ? {} : { sources: report.sources }),
        ...page(taskDataJson(report), args.offset) };
    },
  });
}
