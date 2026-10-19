import { describe, expect, it } from 'vitest';
import { taskTestDb } from './task-test-db';
import { attachTask } from './task-store';
import { agentDefinition } from './definitions';
import { initializeConversation } from './conversation-store';
import { ToolRegistry } from './tools';
import { registerStrategyObservationTools } from './strategy-observation-tools';
import type { RuntimeAgentEnv } from './env';

async function fixture(historicalReference = false) {
  const f = taskTestDb();
  const definition = agentDefinition('strategy_research');
  const task = await attachTask(f.db, f.run(), definition);
  f.sqlite.exec(`
    alter table sites add column workspace_id text default 'w';
    alter table sites add column domain text default 'blog.example.com';
    alter table sites add column domain_status text default 'live';
    alter table sites add column source_locale text default 'en';
    alter table sites add column translate_locales_json text default '[]';
    alter table sites add column locale_policy_json text default '{"defaultCode":"en","locales":[{"code":"en","prefix":"en"}],"redirects":[]}';
    create table jobs(id text primary key,site_id text,status text,visibility text,versions_json text,created_at text,updated_at text,published_at text,content_updated_at text);
    create table seo_strategy_versions(id text primary key,site_id text,source_locale text,locale_version integer,status text,change_summary text,business_snapshot_json text,created_at text);
    create table seo_research_sources(id text, strategy_version_id text, url text, title text, query text, locale text, market text, observed_at text, observation_md text);
    create table seo_strategy_documents(strategy_version_id text,doc_type text,body_md text,content_hash text);
    insert into seo_strategy_versions values('base','s','en',1,'superseded','Baseline','{}','2026-01-01'),('new','s','en',2,'active','New','{}','2026-01-02'),('foreign','s','pt-BR',1,'active','Other locale','{}','2026-01-01');
    insert into seo_strategy_documents values('base','strategy','Original strategy','base-hash'),('new','strategy','Changed strategy','new-hash');
  `);
  await initializeConversation(f.db, task, 'Research', { base_strategy_version_id: 'base' });
  const env = { DB: f.db } as RuntimeAgentEnv;
  const registry = new ToolRegistry();
  registerStrategyObservationTools(registry, env, 'en', 1, historicalReference);
  const context = { runId: task.active_run_id, workspaceId: 'w', siteId: 's', idempotencyKey: 'read' };
  const read = async (name: string, args: unknown, overrides = {}) => {
    const tool = registry.resolve(definition, name);
    return await tool.execute!(tool.inputSchema.parse(args), { ...context, ...overrides }) as Record<string, any>;
  };
  return { ...f, task, read };
}

describe('strategy observation contracts', () => {
  it('returns earlier versions as read-only content without storage identities from v36', async () => {
    const f = await fixture(true);
    f.sqlite.exec(`
      create table seo_topic_territories(id text,strategy_version_id text,territory_key text,name text,priority_band text,status text,audience_summary text,search_job_summary text,business_goal text,conversion_goal text,summary text,sort_order integer);
      create table seo_keyword_clusters(id text,strategy_version_id text,territory_id text,cluster_key text,name text,priority_band text,status text,strategic_role text,recommended_hub text,conversion_goal text,summary text,sort_order integer);
      insert into seo_topic_territories values('territory-id','base','writing-key','Writing','high','active','Learners','Practise','Trial','Trial','Writing',0);
      insert into seo_keyword_clusters values('cluster-id','base','territory-id','replies-key','Replies','high','active','Task','Guides','Trial','Replies',0);
    `);
    const territories = await f.read('read_strategy', { section: 'territories' });
    const clusters = await f.read('read_strategy', { section: 'clusters' });
    expect(territories).toMatchObject({ access: 'read_only_historical_version', items: [{ name: 'Writing', audience_summary: 'Learners' }] });
    expect(clusters).toMatchObject({ access: 'read_only_historical_version', items: [{ territory_name: 'Writing', name: 'Replies', strategic_role: 'Task' }] });
    expect(JSON.stringify([territories.items, clusters.items])).not.toMatch(/territory-id|cluster-id|writing-key|replies-key/);
    expect(await f.read('read_strategy', { section: 'strategy' })).toMatchObject({ access: 'read_only_historical_version', excerpt: 'Original strategy' });
  });

  it('keeps the captured strategy version stable and rejects another locale', async () => {
    const f = await fixture();
    expect(await f.read('read_strategy', { section: 'strategy' })).toMatchObject({ version: { id: 'base' }, excerpt: 'Original strategy' });
    expect(await f.read('read_strategy', { section: 'strategy', version_id: 'new' })).toMatchObject({ version: { id: 'new' }, excerpt: 'Changed strategy' });
    expect((await f.read('read_strategy', {})).items.map((row: any) => row.id)).toEqual(['new', 'base']);
    await expect(f.read('read_strategy', { section: 'strategy', version_id: 'foreign' })).rejects.toThrow('task locale');
  });

  it('returns complete document pages without truncation or changing the version', async () => {
    const f = await fixture();
    const body = 'a'.repeat(16000) + 'tail';
    f.sqlite.prepare("update seo_strategy_documents set body_md=? where strategy_version_id='base'").run(body);
    const first = await f.read('read_strategy', { section: 'strategy' });
    const last = await f.read('read_strategy', { section: 'strategy', offset: first.next_offset });
    expect(first.excerpt + last.excerpt).toBe(body);
    expect(last.next_offset).toBeNull();
    expect(last.version.id).toBe('base');
  });

  it('pages historical source observations and rejects a source from another version', async () => {
    const f = await fixture();
    const observation = 'e'.repeat(16000) + 'remaining evidence';
    f.sqlite.prepare('insert into seo_research_sources values(?,?,?,?,?,?,?,?,?)').run('source', 'base', 'https://example.com/source', 'Original', '', 'en', 'US', '2026-01-01', observation);
    const index = await f.read('read_strategy', { section: 'sources' });
    expect(index.items[0]).toMatchObject({ id: 'source', observation_characters: observation.length });
    expect(index.items[0].observation_excerpt).toHaveLength(1000);
    const first = await f.read('read_strategy', { section: 'sources', source_id: 'source' });
    const second = await f.read('read_strategy', { section: 'sources', source_id: 'source', offset: first.next_offset });
    expect(first.excerpt + second.excerpt).toBe(observation);
    expect(first.freshness).toBe('not_reverified');
    await expect(f.read('read_strategy', { section: 'sources', source_id: 'source', version_id: 'new' })).rejects.toThrow('this strategy version');
  });

  it('distinguishes drafts and hidden assets from public content while retaining full read access', async () => {
    const f = await fixture();
    for (const [id, status, visibility, locale] of [['public', 'published', 'visible', 'en'], ['draft', 'awaiting_review', 'visible', 'en'], ['hidden', 'published', 'hidden', 'en'], ['foreign', 'published', 'visible', 'pt-BR']]) {
      f.sqlite.prepare('insert into jobs values(?,?,?,?,?,?,?,?,?)').run(id, 's', status, visibility,
        JSON.stringify([{ locale, slug: id, title: id, excerpt: 'summary', content: `Full ${id}` }]), '2026-01-01', '2026-01-01', null, null);
    }
    const inventory = await f.read('read_site_content', {});
    expect(inventory.items).toHaveLength(3);
    expect(inventory.items.find((row: any) => row.job_id === 'public')).toMatchObject({ publicly_visible: true, url: 'https://blog.example.com/en/blog/public' });
    for (const id of ['draft', 'hidden']) {
      expect(await f.read('read_site_content', { job_id: id })).toMatchObject({ publicly_visible: false, url: null, excerpt: `Full ${id}`, indexing: 'unknown' });
    }
    await expect(f.read('read_site_content', {}, { workspaceId: 'other' })).rejects.toThrow('workspace');
    await expect(f.read('read_site_content', { job_id: 'foreign' })).rejects.toThrow('task locale');
  });

  it('attributes historical research to its original market and excludes another site', async () => {
    const f = await fixture();
    const childRun = f.run('research', 'research');
    childRun.agent_id = 'deep_research';
    childRun.summary_json = JSON.stringify({ locale: 'pt-BR', research_question: 'What is known?' });
    const child = await attachTask(f.db, childRun, agentDefinition('deep_research'));
    await f.db.prepare("update agent_tasks set status='completed',outcome='partial',workspace_json=? where id=?")
      .bind(JSON.stringify({ report: 'Historical evidence', unknowns: ['Market size'] }), child.id).run();
    expect(await f.read('read_evidence', { section: 'report', research_task_id: child.id })).toMatchObject({ locale: 'pt-BR', target_locale: 'en', scope: 'cross_market', outcome: 'partial' });
    expect((await f.read('read_evidence', {})).research.map((row: any) => row.id)).toContain(child.id);
    await f.db.prepare("update agent_tasks set site_id='another-site' where id=?").bind(child.id).run();
    await expect(f.read('read_evidence', { section: 'report', research_task_id: child.id })).rejects.toThrow('this site');
    expect((await f.read('read_evidence', {})).research).toEqual([]);
  });
});

it('reads provider reports and excerpts without claiming a captured webpage',async()=>{
  const f=await fixture();
  const childRun={...f.run('provider-child','provider-child'),agent_id:'deep_research' as const,parent_run_id:f.task.active_run_id,summary_json:JSON.stringify({locale:'pt-BR'})};
  const child=await attachTask(f.db,childRun,agentDefinition('deep_research'));
  const source={id:'provider-source',url:'https://example.com/',title:'Provider source',captured_at:'2026-09-07',evidence_type:'provider_excerpt',excerpt:'Provider excerpt only'};
  await f.db.prepare('update agent_tasks set output_json=? where id=?').bind(JSON.stringify({outcome:'partial',report:'Hosted report',findings:[],unknowns:[],sources:[source]}),child.id).run();
  const report=await f.read('read_evidence',{section:'report',research_task_id:child.id});
  expect(report.excerpt).toContain('Hosted report');
  expect(report.sources[0].evidence_type).toBe('provider_excerpt');
  expect(await f.read('read_evidence',{section:'source',research_task_id:child.id,source_id:source.id})).toMatchObject({independently_verified:false,evidence_type:'provider_excerpt',excerpt:'Provider excerpt only',scope:'cross_market'});
  await expect(f.read('read_evidence',{section:'source',research_task_id:'another-tenant-task',source_id:source.id})).rejects.toThrow();
});
