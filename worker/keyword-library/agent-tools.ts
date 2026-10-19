import { z } from 'zod';
import { createKeywordLibraryTools } from './tools';
import { KeywordLibrary } from './service';
import { libraryToolNames, type LibraryToolSet } from './catalog';
import { scopeSchema, type Scope } from './contracts';
import type { AgentTask, TaskOperation } from '../agent-runtime/task-store';
import { bindOperation, resolveSlot, saveSlot } from '../agent-runtime/parameter-slots';
import { ToolRegistry } from '../agent-runtime/tools';
import { ToolContractError } from '../agent-runtime/tool-failure';

export type LibraryObservation = { scope: Scope; id: string; revision: number; name?: string; kind?: string };
const referenceFields: Record<string, string[]> = {
  read_library_entry: ['reference'], revise_library_keyword: ['reference'], revise_library_topic_group: ['reference'],
  revise_library_cluster: ['reference'], organize_library_membership: ['parent', 'child'], relate_library_topic: ['keyword'],
};
/** Relationship inputs accept durable identities as well as observations; content revisions still require observations. */
const relationSelectors: Record<string, string> = {
  relate_library_topic: 'keyword by its observation_ref, id or exact name',
  organize_library_membership: 'parent and child by observation_ref or id',
};
function invalid(message: string): never {
  throw new ToolContractError(message, { kind: 'invalid_request', effects: 'none', issues: [{ path: ['library_ref'], message }], guidance: 'Open the intended permitted language and use the observation references returned by library reads.' });
}
export function mountLibraryTools(registry: ToolRegistry, input: {
  db: D1Database; task: AgentTask; operation: TaskOperation; locales: string[] | (() => Promise<string[]>); sets: readonly LibraryToolSet[];
}) {
  const { db, task, operation } = input;
  const permittedLocales = async () => typeof input.locales === 'function' ? input.locales() : input.locales;
  const common = { version: 1, timeoutMs: 15000, retryable: false, approval: 'never' as const, outputSchema: z.unknown(), preserveOutputSize: true };
  registry.register({ ...common, name: 'list_keyword_library_languages', capability: 'read',
    description: 'List permitted project languages, including languages with no entries, and counts of active keywords, topic groups and clusters.',
    inputSchema: z.object({}).strict(), execute: async () => {
      const rows = await db.prepare(`select locale,kind,count(*) as count from keyword_library_entries where workspace_id=? and site_id=? and archived=0 group by locale,kind order by locale,kind`).bind(task.workspace_id, task.site_id).all<{locale:string;kind:string;count:number}>();
      const locales = await permittedLocales();
      return { languages: locales.map(locale => ({ locale })), distribution: rows.results.filter(row => locales.some(locale => new Intl.Locale(locale).toString() === row.locale)) };
    },
  });
  registry.register({ ...common, name: 'open_keyword_library' , capability: 'read',
    description: 'Open the keyword library for a permitted task language. Returns a library_ref to select on subsequent calls. Does not create keywords. Language is bound by the task; permitted languages are listed in task context.',
    inputSchema: z.object({ locale: z.string().min(1) }).strict(),
    execute: async args => {
      const scope = scopeSchema.parse({ workspace_id: task.workspace_id, site_id: task.site_id, ...args });
      if (!(await permittedLocales()).some(locale => new Intl.Locale(locale).toString() === scope.locale)) invalid('Language is outside this task');
      return { library_ref: await saveSlot(db as never, task, 'keyword_library_scope', scope), locale: scope.locale };
    },
  });
  // One domain adapter for all consumers, using existing durable slot/operation mechanisms.
  const template = createKeywordLibraryTools(async () => { throw new Error('Unbound catalog'); }, { sets: input.sets });
  const definition = { tools: template.names() } as unknown as Parameters<ToolRegistry['resolve']>[0];
  for (const name of template.names()) {
    const tool = template.resolve(definition, name);
    const schema = tool.inputSchema as z.ZodObject;
    registry.register({ ...tool, version: 2, inputSchema: schema.extend({ library_ref: z.string().min(1) }), outputSchema: z.unknown(),
      description: tool.description + ' Supply library_ref from open_keyword_library. ' + (relationSelectors[name]
        ? `Select ${relationSelectors[name]}. Relationship writes do not require the latest observation.`
        : 'For existing entry inputs select observation_ref, not the display id. Reads and write receipts return fresh observation_ref values.'),
      execute: async (raw, context) => {
        const args = raw as Record<string, unknown>;
        const resolve = async () => {
          const scope = await resolveSlot<Scope>(db as never, task, String(args.library_ref), 'keyword_library_scope');
          if (scope.workspace_id !== task.workspace_id || scope.site_id !== task.site_id || !(await permittedLocales()).some(locale => new Intl.Locale(locale).toString() === scope.locale)) invalid('Library scope is outside this task');
          const values = { ...args }; delete values.library_ref;
          const revisions: Record<string, number> = {};
          for (const field of [...(referenceFields[name] || []), ...(name === 'list_library_entries' && args.parent_id ? ['parent_id'] : [])]) {
            const value = String(args[field]);
            if (relationSelectors[name] && !value.startsWith('ref-')) {
              // A relationship needs only a real entry of this language; the domain checks its kind.
              const library = new KeywordLibrary(db as never, scope);
              values[field] = name === 'relate_library_topic'
                ? (await library.get(value).catch(() => library.getByName('keyword', value))).id
                : (await library.get(value)).id;
              continue;
            }
            const observed = await resolveSlot<LibraryObservation>(db as never, task, value, 'keyword_library_entry', field);
            if (JSON.stringify(observed.scope) !== JSON.stringify(scope)) invalid('Entry observation belongs to a different language');
            values[field] = observed.id; revisions[observed.id] = observed.revision;
          }
          return { scope, values, revisions };
        };
        const resolved = tool.capability === 'write' ? await bindOperation(db as never, task, operation, args, resolve) : await resolve();
        const bound = createKeywordLibraryTools(async () => ({ db, scope: resolved.scope,
          actor: { type: 'agent', id: task.agent_id, task_id: task.id, run_id: task.active_run_id }, observed_revisions: resolved.revisions }), { sets: input.sets });
        const result = await bound.execute(definition, name, resolved.values, context) as Record<string, any>;
        const decorate = async (entry: Record<string, any>) => ({ ...entry, observation_ref: await saveSlot(db as never, task, 'keyword_library_entry', {
          scope: resolved.scope, id: entry.id, revision: entry.revision, ...(entry.name ? { name: entry.name, kind: entry.kind } : {}),
        } satisfies LibraryObservation) });
        if (name === 'list_library_entries') result.items = await Promise.all(result.items.map(decorate));
        if (name === 'read_library_entry') result.entry = await decorate(result.entry);
        if (tool.capability === 'write') result.observation_ref = (await decorate({ id: result.target_id, revision: result.revision })).observation_ref;
        // A membership write advances both entries; return fresh references for each side.
        if (tool.capability === 'write' && Array.isArray(result.related)) result.related = await Promise.all(result.related.map(decorate));
        return result;
      },
    });
  }
  return registry;
}
export const agentLibraryToolNames = (sets: readonly LibraryToolSet[]) => ['list_keyword_library_languages', 'open_keyword_library', ...libraryToolNames(sets)];
