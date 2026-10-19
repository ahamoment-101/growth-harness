import { readRuntimeJson } from './runtime-content';
import { z } from 'zod';
import type { RuntimeAgentEnv } from './env';
import type { AgentTask, TaskOperation } from './task-store';
import { requireTask } from './task-store';
import type { ToolRegistry, RuntimeTool } from './tools';
import { bindOperation, resolveSlot, saveSlot, slotBatch } from './parameter-slots';
import { strategyBlueprintSchema, strategyClusterSchema, strategyKeywordSchema, strategyTerritorySchema } from '../lib/research/ingest';
import { strategyWorkspace } from './strategy-task';
import { ToolContractError } from './tool-failure';
import type { UrlCitation } from '../lib/llm';
import { strategyReportDelivery } from '../lib/research/report-delivery';

const ref = z.string().min(1);
const judgment = z.string().max(1000).default('');
const keywordValues = strategyKeywordSchema.omit({ id: true, locale: true, cluster_key: true, source_urls: true, existing_url: true, existing_page_state: true });
const placement = { cluster_ref: ref, source_refs: z.array(ref),
  existing_page: z.strictObject({ state: z.enum(['present', 'none', 'unknown']), page_ref: z.string() }) };
const keywordCreate = keywordValues.extend(placement);
const keywordPatch = keywordValues.partial().extend({ cluster_ref: ref.optional(), source_refs: z.array(ref).optional(), existing_page: placement.existing_page.optional() });
const blueprintValues = strategyBlueprintSchema.omit({ territories: true, clusters: true }).partial();
const territoryValues = strategyTerritorySchema.omit({ key: true });
const clusterValues = strategyClusterSchema.omit({ key: true, territory_key: true });
const createKey = z.string().trim().min(1).max(100);
const blueprintInputFor = (directions: boolean, sameCallLinks: boolean) => z.strictObject({ workspace_ref: ref, judgment_summary: judgment,
  blueprint: blueprintValues,
  // From v36 a territory created in this call can carry a call-local create_key so clusters in the same call can join it.
  territories: z.array(z.strictObject({ ref: ref.optional(), ...(sameCallLinks ? { create_key: createKey.optional()
    .describe('Only for a territory created in this call: a call-local label that clusters in this same call select with territory_create_key. Not stored.') } : {}),
  values: territoryValues.partial() })).default([]),
  // From v34 a cluster is a demand direction; it selects its evidence from the catalog instead of citing refs in prose.
  clusters: z.array(z.strictObject({ ref: ref.optional(), territory_ref: ref.optional(), ...(sameCallLinks ? { territory_create_key: createKey.optional()
    .describe('Select a territory created earlier in this same call by its create_key, instead of territory_ref') } : {}),
    values: (directions ? clusterValues.extend({ source_refs: z.array(ref).describe('Evidence refs from the workspace source catalog supporting this demand direction') }) : clusterValues).partial() })).default([]),
  remove_territories: z.array(ref).default([]), remove_clusters: z.array(ref).default([]),
});
function reject(path: string | Array<string | number>, message: string): never {
  throw new ToolContractError(message, { kind: 'invalid_request', effects: 'none', issues: [{ path: Array.isArray(path) ? path : [path], message }], guidance: 'Preserve saved work. Read the workspace and evidence catalog, then correct only the rejected changes.' });
}
export const STRATEGY_SLOT_INSTRUCTIONS = `Stable parameters are host-owned. First read_strategy_workspace for workspace_ref and object references. Never reconstruct IDs, locale, versions or source URLs. Each mutation consumes the observed workspace_ref; read the returned updated references before a dependent mutation. Use create_strategy_blueprint with all blueprint text fields when no blueprint exists; use patch_strategy_blueprint for later partial changes. Territory/cluster entries without ref create objects and receive system identities; entries with ref patch existing objects; omitted entries are preserved. Create territories before choosing their refs for clusters. update_strategy_keywords separates create, patch and remove; never use patch to create. Select evidence refs; URL resolution is host-owned. Existing page state must distinguish present, none and unknown. Business modules may be public research, not human-confirmed facts. GSC unavailable means measured traffic/rank is unknown. Review feedback does not authorize publication.`;

/** From definition v34 the workspace carries no keyword list, so keyword placement guidance is absent. */
/** From v36: the draft is this task's new version; earlier versions are read-only reference. */
export const STRATEGY_DRAFT_SLOT_INSTRUCTIONS = `Stable parameters are host-owned. Never reconstruct IDs, locale, versions or source URLs.
This task writes exactly one thing: its own new-version draft, which becomes the next strategy version when submit_strategy succeeds. read_strategy_workspace reads that draft; its draft section states whether it is empty and which version it is based on. Every earlier version, including the base version, is read-only reference read through read_strategy. Nothing returned by read_strategy selects or edits draft objects, and the base version is never copied into the draft for you.
Before writing, read the base version when one exists and decide for each territory and demand direction whether to keep, adjust or drop it in light of this task's research; add new ones where research supports them. Record those decisions in change_summary. Evidence the base version relied on stays selectable in the workspace source catalog.
For the first write, prefer one complete create_strategy_blueprint call containing all blueprint text fields, territories and demand directions: give each new territory a create_key and join its clusters to it with territory_create_key. Afterwards use patch_strategy_blueprint for targeted revisions of saved draft objects, selecting them by the refs read_strategy_workspace returns. Entries without ref create objects and receive system identities; entries with ref patch existing draft objects; omitted entries are preserved. Each mutation consumes the observed workspace_ref; use the returned references for the next dependent mutation.
Clusters are demand directions: attach their supporting evidence with source_refs selected from the workspace source catalog; URL resolution is host-owned. Refs and create_keys are selectors for tool inputs only and never belong in blueprint prose. Business modules may be public research, not human-confirmed facts. GSC unavailable means measured traffic/rank is unknown. Review feedback does not authorize publication.`;
export const STRATEGY_DIRECTION_SLOT_INSTRUCTIONS = `Stable parameters are host-owned. First read_strategy_workspace for workspace_ref and object references. Never reconstruct IDs, locale, versions or source URLs. Each mutation consumes the observed workspace_ref; read the returned updated references before a dependent mutation. Use create_strategy_blueprint with all blueprint text fields when no blueprint exists; use patch_strategy_blueprint for later partial changes. Territory/cluster entries without ref create objects and receive system identities; entries with ref patch existing objects; omitted entries are preserved. Create territories before choosing their refs for clusters. Clusters are demand directions: attach their supporting evidence with source_refs selected from the workspace source catalog; URL resolution is host-owned. Refs are selectors for tool inputs only and never belong in blueprint prose. Business modules may be public research, not human-confirmed facts. GSC unavailable means measured traffic/rank is unknown. Review feedback does not authorize publication.`;

export function applyStrategySlots(registry: ToolRegistry, input: { env: RuntimeAgentEnv; task?: AgentTask; operation?: TaskOperation; locale?: string; directions?: boolean; evidence: (taskId: string) => Promise<UrlCitation[]> }) {
  const { env, task, operation, locale } = input;
  const draftContract = (task?.definition_version || 0) >= 36;
  const blueprintInput = blueprintInputFor(Boolean(input.directions), draftContract);
  if (task && ![1, 2].includes(task.parameter_contract_version || 0)) return registry;
  const resolve = <T>(r: string, kind: string, path = kind === 'strategy_workspace' ? 'workspace_ref' : `${kind}_ref`) => resolveSlot<T>(env.DB, task!, r, kind, path);
  async function catalog() {
    const current = await requireTask(env.DB, task!.active_run_id);
    const workspace = strategyWorkspace(current);
    const batch = slotBatch(env.DB, current);
    const save = batch.add;
    const conversation = await env.DB.prepare('select context_json from agent_conversations where task_id=?').bind(current.id).first<{context_json: string}>();
    const base = conversation ? String((await readRuntimeJson<Record<string, any>>(env.DB, conversation.context_json)).base_strategy_version_id || '') : '';
    const workspace_ref = await save('strategy_workspace', { revision: current.revision, base_version_id: base });
    const reportDelivery = current.definition_version >= 29 ? { report_delivery: await strategyReportDelivery(env.DB, current.site_id, locale!, base) } : {};
    const territories = await Promise.all((workspace.blueprint?.territories || []).map(async item => ({ ...item, ref: await save('territory', item.key) })));
    const clusters = await Promise.all((workspace.blueprint?.clusters || []).map(async item => ({ ...item, ref: await save('cluster', item.key), territory_ref: await save('territory', item.territory_key) })));
    const keywords = await Promise.all(workspace.keywords.map(async item => ({ ...item,
      ref: await save('keyword', item.id || { term: item.term }),
      cluster_ref: await save('cluster', item.cluster_key) })));
    await batch.commit();
    const sources = await Promise.all((await input.evidence(current.id)).map(async source => ({
      url: source.url, title: source.title, query: source.query,
      ref: await save('strategy_source', source), page_ref: await save('page_url', source.url),
    }))); // Full sources remain in the evidence archive; workspace inspection returns selectors.
    await batch.commit();
    const baseVersion = draftContract && base ? await env.DB.prepare('select locale_version from seo_strategy_versions where id=?').bind(base).first<{locale_version: number}>() : null;
    const draft = draftContract ? { draft: { scope: 'this_task_new_version_draft', becomes: 'the next strategy version when submit_strategy succeeds',
      state: workspace.blueprint ? 'has_blueprint' : 'empty', territories: workspace.blueprint?.territories.length || 0, clusters: workspace.blueprint?.clusters.length || 0,
      base_version: baseVersion ? { version: baseVersion.locale_version, access: 'read_only', read_with: 'read_strategy with empty version_id' } : null } } : {};
    // Demand directions show their evidence as catalog refs, the same selectors a revision uses.
    const directionClusters = input.directions ? clusters.map(cluster => ({ ...cluster,
      source_refs: (cluster.source_urls || []).map(url => sources.find(source => source.url === url)?.ref || '').filter(Boolean) })) : clusters;
    return { ...draft, workspace_ref, sources, ...reportDelivery, workspace: { ...workspace, blueprint: workspace.blueprint ? { ...workspace.blueprint, territories, clusters: directionClusters } : undefined, keywords } };
  }
  async function observed(r: string) {
    const value = await resolve<{revision: number; base_version_id: string}>(r, 'strategy_workspace');
    const current = await requireTask(env.DB, task!.active_run_id);
    if (current.revision !== value.revision) throw new ToolContractError('Observed workspace revision changed', { kind: 'state_conflict', effects: 'preserved', issues: [{ path: ['workspace_ref'], message: 'Reference represents an older revision' }], guidance: 'Read current workspace and reconcile changes before writing.' });
    return { current, value, workspace: strategyWorkspace(current) };
  }
  return registry.mapTools(original => {
    const tool: RuntimeTool = { ...original, parameterBindings: { system: ['workspace_id', 'site_id', 'task_id', 'locale', 'run_id', 'operation_id'], references: [] } };
    const execute = original.execute!;
    const wrap = (schema: z.ZodType, translate: (args: any) => Promise<any>, result = false): RuntimeTool => ({ ...tool, version: 2, inputSchema: schema, outputSchema: z.unknown(),
      parameterBindings: { system: ['workspace_id', 'site_id', 'task_id', 'locale', 'run_id', 'operation_id'], references: ['workspace_ref', 'object_refs'] },
      execute: async (args, ctx) => {
        const resolved = await bindOperation(env.DB, task!, operation!, args, () => translate(args));
        const output = await execute(resolved, ctx);
        return result ? { result: output, ...await catalog() } : output;
      } });
    if (tool.name === 'read_strategy_workspace') return { ...tool,
      inputSchema: z.strictObject({ offset: z.number().int().nonnegative().default(0), judgment_summary: judgment }), outputSchema: z.unknown(),
      description: (draftContract ? 'Read this task\'s new-version draft: its draft identity and state, observed workspace reference, references to draft objects and evidence. Earlier versions are not here; read them with read_strategy. ' : 'Read observed workspace reference, stable object references and evidence. ')
        + 'Offset pages through workspace JSON.',
      execute: async (args: any) => {
        const value = await catalog(); const content = JSON.stringify(value.workspace);
        return { ...value, workspace: undefined, excerpt: content.slice(args.offset, args.offset + 20000), next_offset: content.length > args.offset + 20000 ? args.offset + 20000 : null };
      } };
    if (tool.name === 'create_strategy_blueprint' || tool.name === 'patch_strategy_blueprint') return { ...wrap(tool.name === 'create_strategy_blueprint' ? blueprintInput.extend({ blueprint: strategyBlueprintSchema.omit({ territories: true, clusters: true }) }) : blueprintInput, async args => {
      const { workspace, value } = await observed(args.workspace_ref);
      const territories = [...(workspace.blueprint?.territories || [])];
      const clusters = [...(workspace.blueprint?.clusters || [])];
      const createdTerritories = new Map<string, string>();
      for (const [kind, rows, entries, removals, schema] of [
        ['territory', territories, args.territories, args.remove_territories, territoryValues],
        ['cluster', clusters, args.clusters, args.remove_clusters, clusterValues],
      ] as const) {
        const seen = new Set<string>();
        for (const r of removals) { const key = await resolve<string>(r, kind); const index = rows.findIndex(row => row.key === key); if (index < 0 || seen.has(key)) reject(kind, 'Object is missing or repeated'); seen.add(key); rows.splice(index, 1); }
        for (const [entryIndex, entry] of entries.entries()) {
          const key = entry.ref ? await resolve<string>(entry.ref, kind) : crypto.randomUUID();
          const old = rows.find(row => row.key === key);
          if ((entry.ref && !old) || seen.has(key)) reject(kind, 'Object is missing or conflicting');
          seen.add(key);
          const { create_key: createKeyValue, territory_create_key: territoryCreateKey } = entry as { create_key?: string; territory_create_key?: string };
          if (createKeyValue) {
            if (entry.ref) reject(['territories', entryIndex, 'create_key'], 'create_key labels only a territory created in this call; an existing territory is selected by ref');
            if (createdTerritories.has(createKeyValue)) reject(['territories', entryIndex, 'create_key'], 'create_key is repeated in this call');
            createdTerritories.set(createKeyValue, key);
          }
          if (territoryCreateKey && entry.territory_ref) reject(['clusters', entryIndex, 'territory_create_key'], 'Select the territory with either territory_ref or territory_create_key, not both');
          const createdTerritory = territoryCreateKey ? createdTerritories.get(territoryCreateKey) : undefined;
          if (territoryCreateKey && !createdTerritory) reject(['clusters', entryIndex, 'territory_create_key'], 'No territory created in this call declares this create_key');
          const { key: _key, territory_key: _territory, source_urls: priorSources, ...priorValues } = (old || {}) as Record<string, unknown>;
          const { source_refs: sourceRefs, ...entryValues } = entry.values as Record<string, unknown>;
          const values = schema.parse({ ...priorValues, ...entryValues });
          const next: any = { ...old, ...values, key };
          if (kind === 'cluster' && input.directions) next.source_urls = Array.isArray(sourceRefs)
            ? await Promise.all(sourceRefs.map(async (r: string, index: number) => (await resolve<UrlCitation>(r, 'strategy_source', `clusters[${entryIndex}].values.source_refs[${index}]`)).url))
            : Array.isArray(priorSources) ? priorSources : [];
          if (kind === 'cluster' && !old && !entry.territory_ref && !createdTerritory) reject(['clusters', entryIndex, 'territory_ref'], draftContract
            ? 'Select this cluster\'s territory with territory_ref from read_strategy_workspace or territory_create_key of a territory created in this call'
            : 'Choose an existing territory_ref from read_strategy_workspace before creating this cluster');
          if (kind === 'cluster') next.territory_key = createdTerritory || (entry.territory_ref ? await resolve<string>(entry.territory_ref, 'territory') : (old as any)?.territory_key);
          if (old) Object.assign(old, next); else (rows as any[]).push(next);
        }
      }
      return { expected_revision: value.revision, judgment_summary: args.judgment_summary, blueprint: { ...workspace.blueprint, ...args.blueprint, territories, clusters } };
    }, true), description: draftContract
      ? (tool.name === 'create_strategy_blueprint'
        ? 'Write the first complete blueprint into this task\'s empty new-version draft: all blueprint text fields plus its territories and demand directions in one call. Give new territories a create_key and join clusters with territory_create_key. '
        : 'Revise the blueprint already saved in this task\'s new-version draft; never creates a missing blueprint. Select saved draft objects by the refs from read_strategy_workspace; entries without ref create new objects, and a territory created in this call can be joined with create_key/territory_create_key. ')
        + 'Omission preserves existing draft objects. Creation requires complete values; system generates identities. Earlier strategy versions are read-only and cannot be edited.'
      : (tool.name === 'create_strategy_blueprint' ? 'Create a complete blueprint only when none exists. All blueprint text fields are required. ' : 'Patch an existing blueprint; never create a missing blueprint. ') + 'Create/patch/remove territories or clusters through references. Omission preserves existing objects. Creation requires complete values; system generates identities. Create territories first, then select their refs for clusters.' };
    if (tool.name === 'update_strategy_keywords') return { ...wrap(z.strictObject({ workspace_ref: ref, create: z.array(keywordCreate).max(12).default([]), patch: z.array(z.strictObject({ keyword_ref: ref, changes: keywordPatch })).max(12).default([]), remove: z.array(ref).default([]), judgment_summary: judgment }), async args => {
      const { workspace, value } = await observed(args.workspace_ref);
      const keywords = workspace.keywords.map(k => ({ ...k })); const removed: any[] = []; const seen = new Set<string>();
      const find = async (r: string) => { const identity = await resolve<string | {term: string}>(r, 'keyword');
        const row = keywords.find(k => typeof identity === 'string' ? k.id === identity : k.term === identity.term);
        if (!row || seen.has(r)) reject('keyword_ref', 'Keyword is missing or used more than once'); seen.add(r); return row; };
      for (const r of args.remove) { const row = await find(r); removed.push({ term: row.term }); keywords.splice(keywords.indexOf(row), 1); }
      async function fields(values: any) {
        const { cluster_ref, source_refs, existing_page, ...content } = values;
        if (cluster_ref) content.cluster_key = await resolve<string>(cluster_ref, 'cluster');
        if (source_refs) content.source_urls = await Promise.all(source_refs.map(async (r: string, index: number) => (await resolve<UrlCitation>(r, 'strategy_source', `source_refs[${index}]`)).url));
        if (existing_page) {
          if (existing_page.state !== 'present' && existing_page.page_ref !== '') reject('existing_page', 'None/unknown must have an empty page_ref');
          content.existing_url = existing_page.state === 'present' ? await resolve<string>(existing_page.page_ref, 'page_url', 'existing_page.page_ref') : '';
          content.existing_page_state = existing_page.state;
        }
        return content;
      }
      const changed: any[] = [];
      for (const entry of args.patch) {
        const old = await find(entry.keyword_ref); const next = { ...old, ...await fields(entry.changes) };
        if (next.term !== old.term) removed.push({term: old.term});
        keywords[keywords.indexOf(old)] = next; changed.push(next);
      }
      for (const values of args.create) { const next = { ...await fields(values), id: crypto.randomUUID(), locale }; keywords.push(next); changed.push(next); }
      const identities = keywords.map(k => k.term.trim().toLowerCase());
      if (new Set(identities).size !== identities.length) reject('create', 'Keyword identity already exists; use its reference to patch');
      const known = new Set((await input.evidence(task!.id)).map(s => s.url));
      for (const k of changed) if (k.source_urls.some((url: string) => !known.has(url))) reject('source_refs', 'Source is absent from task evidence');
      return { expected_revision: value.revision, keywords: changed, remove_keywords: removed, judgment_summary: args.judgment_summary };
    }, true), description: 'Create complete keywords, patch selected keyword refs, or remove refs. Never upsert by generated identity. Task supplies locale. Choose cluster/source refs from workspace. Observe returned workspace_ref before subsequent edits.' };
    if (tool.name === 'read_site_content' || tool.name === 'read_web_page') return { ...tool, execute: async (args, ctx) => {
      const output = await execute(args, ctx) as any;
      const page = async (row: any) => row.url ? { ...row, page_ref: await saveSlot(env.DB, task!, 'page_url', row.url) } : row;
      if (output.items) output.items = await Promise.all(output.items.map(page));
      return page(output);
    } };
    if (tool.name === 'read_strategy') return { ...tool, execute: async (args, ctx) => {
      const output = await execute(args, ctx) as any;
      if (output.items && (args as any).section === 'versions') output.items = await Promise.all(output.items.map(async (item: any) => ({ ...item, version_ref: await saveSlot(env.DB, task!, 'strategy_version', item.id) })));
      if (output.version?.id) output.version_ref = await saveSlot(env.DB, task!, 'strategy_version', output.version.id);
      return output;
    } };
    if (tool.name === 'review_strategy' || tool.name === 'submit_strategy') return wrap(z.strictObject({ workspace_ref: ref, judgment_summary: judgment, ...(tool.name === 'review_strategy' ? { focus: z.string() } : { base_version_ref: ref.optional() }) }), async args => {
      const { value } = await observed(args.workspace_ref);
      return { expected_revision: value.revision, expected_base_version_id: args.base_version_ref ? await resolve<string>(args.base_version_ref, 'strategy_version') : value.base_version_id, focus: args.focus, judgment_summary: args.judgment_summary };
    }, tool.name === 'review_strategy');
    return tool;
  });
}

/** Persist useful recovery feedback in the same transaction as the domain write. */
export async function strategySlotReceipt(env: RuntimeAgentEnv, task: AgentTask, revision: number, workspace: import('./strategy-task').StrategyWorkspace) {
  if (![1, 2].includes(task.parameter_contract_version || 0)) return {};
  const initial = await env.DB.prepare('select context_json from agent_conversations where task_id=?').bind(task.id).first<{context_json: string}>();
  const base = initial ? String((await readRuntimeJson<Record<string, any>>(env.DB, initial.context_json)).base_strategy_version_id || '') : '';
  const batch = slotBatch(env.DB, task);
  const receipt = {
    workspace_ref: await batch.add('strategy_workspace', { revision, base_version_id: base }),
    territories: await Promise.all((workspace.blueprint?.territories || []).map(async row => ({ name: row.name, ref: await batch.add('territory', row.key) }))),
    clusters: await Promise.all((workspace.blueprint?.clusters || []).map(async row => ({ name: row.name, ref: await batch.add('cluster', row.key) }))),
    keywords: await Promise.all(workspace.keywords.map(async row => ({ term: row.term, ref: await batch.add('keyword', row.id || {term: row.term}) }))),
  };
  await batch.commit();
  return receipt;
}
