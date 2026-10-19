import { ToolContractError } from '../../agent-runtime/tool-failure';
import { z } from 'zod';
import type { RuntimeAgentEnv } from '../../agent-runtime/env';
import { requireTask, type AgentTask } from '../../agent-runtime/task-store';
import { persistRuntimeJson, readRuntimeJson } from '../../agent-runtime/runtime-content';
import { indexSourceText, indexedSourcePage, sourceTextPage, type SourceTextIndex } from './source-pages';

export const findingSchema = z.object({
  claim: z.string().min(1).max(6000), kind: z.enum(['fact', 'inference', 'uncertain']),
  evidence: z.array(z.object({ source_id: z.string(), quote: z.string().min(1).max(6000), relation: z.enum(['supports', 'contradicts']) })).max(30),
});
export type Finding = z.infer<typeof findingSchema>;
export type ResearchSource = { id: string; task_id: string; workspace_id: string; site_id: string; url: string; title: string; captured_at: string; object_key: string; content_hash: string; content_length: number };
export function sourceReference(source: ResearchSource) {
  return { source_id: source.id, url: source.url, title: source.title, captured_at: source.captured_at };
}
export async function sourceIndex(env: RuntimeAgentEnv, taskId: string): Promise<ResearchSource[]> {
  return (await env.DB.prepare('select * from research_sources where task_id = ? order by captured_at,id').bind(taskId).all<ResearchSource>()).results;
}
async function authorizedSource(env: RuntimeAgentEnv, task: AgentTask, sourceId: string) {
  const source = await env.DB.prepare('select * from research_sources where id = ? and task_id = ? and workspace_id = ? and site_id = ?')
    .bind(sourceId, task.id, task.workspace_id, task.site_id).first<ResearchSource>();
  if (!source) {
    const available = (await sourceIndex(env, task.id)).map(sourceReference);
    throw new ToolContractError('Source does not belong to this research task', { kind: 'invalid_request', effects: 'none', issues: [{ path: ['source_id'], message: `Unknown source ID: ${sourceId}` }], guidance: 'Search snippets have no saved source identity. Call read_web_page with the public URL, then use its returned source ID and exact page text. Never invent IDs such as s1. Existing notebook is preserved. Available source references: ' + JSON.stringify(available) });
  }
  return source;
}
export async function readSource(env: RuntimeAgentEnv, task: AgentTask, sourceId: string) {
  const source = await authorizedSource(env, task, sourceId);
  if (!env.RESEARCH_BUCKET) throw new Error('RESEARCH_BUCKET is not configured');
  const object = await env.RESEARCH_BUCKET.get(source.object_key);
  if (!object) throw new Error('Evidence snapshot is unavailable');
  return { source, content: await object.text() };
}
export async function readSourcePage(env: RuntimeAgentEnv, task: AgentTask, sourceId: string, offset: number) {
  const source = await authorizedSource(env, task, sourceId);
  if (!env.RESEARCH_BUCKET) throw new Error('RESEARCH_BUCKET is not configured');
  const row = await env.DB.prepare('select index_json from research_source_indexes where source_id=?').bind(source.id).first<{ index_json: string }>();
  if (row) {
    const index = await readRuntimeJson<SourceTextIndex>(env.DB, row.index_json);
    if (index.encoding !== 'utf8-index-v1' || index.object_key !== source.object_key || index.characters !== source.content_length) throw new Error('Evidence index does not match source');
    return { source, ...await indexedSourcePage(env.RESEARCH_BUCKET, index, offset), total_characters: index.characters, offset_unit: 'characters' };
  }
  // Historical objects have no byte index; preserve access without modifying them.
  const { content } = await readSource(env, task, sourceId);
  return { source, ...sourceTextPage(content, offset), total_characters: content.length, offset_unit: 'characters' };
}
export async function saveSource(env: RuntimeAgentEnv, task: AgentTask, url: string, content: string): Promise<ResearchSource> {
  if (!env.RESEARCH_BUCKET) throw new Error('RESEARCH_BUCKET is not configured');
  await requireTask(env.DB, task.active_run_id);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url + '\n' + content))), b => b.toString(16).padStart(2, '0')).join('');
  const key = `research/${encodeURIComponent(task.workspace_id)}/${encodeURIComponent(task.id)}/${hash}.md`;
  const id = `${task.id}:${hash}`;
  const existing = await env.DB.prepare('select * from research_sources where id=? and task_id=? and workspace_id=? and site_id=?')
    .bind(id, task.id, task.workspace_id, task.site_id).first<ResearchSource>();
  if (existing) {
    const head = await env.RESEARCH_BUCKET.head(key);
    if (head) {
      const row = await env.DB.prepare('select index_json from research_source_indexes where source_id=?').bind(id).first<{ index_json: string }>();
      const index = row ? await readRuntimeJson<SourceTextIndex>(env.DB, row.index_json) : null;
      if (head.size !== new TextEncoder().encode(content).length || (index && head.etag !== index.etag)) throw new Error('Evidence snapshot changed');
      return existing; // Exact task, URL and complete body hash; never merge different captures.
    }
    // A confirmed missing object can be restored from this exact hash-matching
    // body. Transient HEAD failures propagate; they never authorize replacement.
  }
  const object = await env.RESEARCH_BUCKET.put(key, content, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
  // The source insert below rechecks ownership and root cancellation after R2.
  const source: ResearchSource = { id, task_id: task.id, workspace_id: task.workspace_id, site_id: task.site_id,
    url, title: content.split('\n')[0].replace(/^#+\s*/, '').slice(0, 300), captured_at: new Date().toISOString(),
    object_key: key, content_hash: hash, content_length: content.length };
  const inserted = await env.DB.prepare(`insert or ignore into research_sources(id,task_id,workspace_id,site_id,url,title,captured_at,object_key,content_hash,content_length)
    select ?,?,?,?,?,?,?,?,?,? where exists(select 1 from agent_tasks t join agent_tasks root on root.id=t.root_task_id
      where t.id=? and t.active_run_id=? and t.epoch=? and t.status='running' and root.status='running')`)
    .bind(id,task.id,task.workspace_id,task.site_id,url,source.title,source.captured_at,key,hash,content.length,
      task.id,task.active_run_id,task.epoch).run();
  if (object?.etag) {
    const index = await persistRuntimeJson(env.DB, indexSourceText(content, key, object.etag));
    await env.DB.prepare(`insert into research_source_indexes(source_id,index_json)
      select ?,? where exists(select 1 from research_sources where id=? and task_id=?)
      and exists(select 1 from agent_tasks where id=? and active_run_id=? and epoch=? and status='running')
      on conflict(source_id) do update set index_json=excluded.index_json`)
      .bind(id, index, id, task.id, task.id, task.active_run_id, task.epoch).run();
  }
  if (inserted.meta.changes) return source;
  await requireTask(env.DB, task.active_run_id);
  const saved = await env.DB.prepare('select * from research_sources where id = ? and task_id = ?').bind(id,task.id).first<ResearchSource>();
  if (!saved) throw new Error('Evidence source lost its execution gate');
  return saved;
}
export async function validateFindings(env: RuntimeAgentEnv, task: AgentTask, findings: Finding[]): Promise<void> {
  const cache = new Map<string, string>();
  for (const finding of findings) for (const reference of finding.evidence) {
    if (!cache.has(reference.source_id)) cache.set(reference.source_id, (await readSource(env, task, reference.source_id)).content);
    if (!cache.get(reference.source_id)!.includes(reference.quote)) throw new ToolContractError('Evidence quote does not occur in its saved source. Read the source and provide an exact excerpt.', { kind: 'invalid_request', effects: 'none', issues: [{ path: ['evidence', reference.source_id, 'quote'], message: 'Quote does not match the saved page text' }], guidance: 'Read the exact saved source and correct this quote; preserve valid findings and sources.' });
  }
}
