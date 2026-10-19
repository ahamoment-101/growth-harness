import { z } from 'zod';
import { executionContext } from '../agent-runtime/execution-context';
import { ToolRegistry, type RuntimeTool, type RuntimeToolContext } from '../agent-runtime/tools';
import { actorSchema, dataSchemas, detailQuerySchema, listSchema, logQuerySchema, referenceSchema, type Actor, type Scope } from './contracts';
import { libraryToolNames, type LibraryToolSet } from './catalog';
import { KeywordLibrary } from './service';

/** Standalone semantic tools; agent-tools.ts mounts selected capabilities with durable host bindings.
 * observed_revisions must come from durable observations, never a latest-row lookup.
 */
export type LibraryToolBinding = {
  db: D1Database; scope: Scope; actor: Actor;
  observed_revisions: Readonly<Record<string, number>>;
};
const reason = z.string().trim();
const receipt = z.object({ log_id: z.string(), target_id: z.string(), revision: z.number(), changed: z.boolean(), related: z.array(z.object({ id: z.string(), revision: z.number() })).optional() });
const entry = z.object({ id: z.string(), kind: z.enum(['keyword', 'topic_group', 'cluster']), name: z.string(), data: z.record(z.string(), z.unknown()), revision: z.number(), archived: z.boolean(), created_at: z.string(), updated_at: z.string() });

export function createKeywordLibraryTools(bind: (context: RuntimeToolContext) => Promise<LibraryToolBinding>, options: { sets?: readonly LibraryToolSet[] } = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const selected = new Set<string>(libraryToolNames(options.sets ?? ['read', 'research', 'topicLinks']));
  function register<I, O>(tool: RuntimeTool<I, O>) {
    if (selected.has(tool.name)) registry.register(tool);
  }
  async function bound(context: RuntimeToolContext, write: boolean) {
    const b = await bind(context);
    if (context.signal?.aborted) throw context.signal.reason;
    if (b.scope.workspace_id !== context.workspaceId || b.scope.site_id !== context.siteId || b.actor.type !== 'agent' || b.actor.run_id !== context.runId) throw new Error('Library host binding does not match the authenticated tool context');
    if (write) {
      const captured = executionContext(b.db);
      if (!captured || !context.execution || captured.runId !== context.runId || captured.taskId !== b.actor.task_id || captured.executionId !== context.execution.executionId || captured.epoch !== context.execution.epoch || captured.taskId !== context.execution.taskId || captured.runId !== context.execution.runId) throw new Error('Library writes require the original execution-scoped database');
    }
    return { library: new KeywordLibrary(b.db, b.scope), actor: b.actor, observed: b.observed_revisions };
  }
  function observed(revisions: Readonly<Record<string, number>>, id: string) {
    const revision = revisions[id];
    if (!Number.isInteger(revision) || revision < 1) throw new Error(`No host-owned observed revision for reference: ${id}`);
    return revision;
  }
  const base = { version: 1, timeoutMs: 15_000, retryable: false, approval: 'never' as const, preserveOutputSize: true };
  register({ ...base, name: 'list_library_entries', capability: 'read', description: 'Find keywords, topic groups or clusters in the host-bound language. Returns stable IDs, revisions and a pagination cursor.', inputSchema: listSchema, outputSchema: z.object({ items: z.array(entry), next: z.string().nullable() }), execute: async (input, context) => (await bound(context, false)).library.list(input) });
  register({ ...base, name: 'read_library_entry', capability: 'read', description: 'Read research fields, group memberships and paginated linked topics for a stable library reference.', inputSchema: detailQuerySchema.extend({ reference: referenceSchema }), outputSchema: z.object({ entry, memberships: z.array(z.object({ parent_id: z.string(), child_id: z.string(), parent_kind: z.enum(['keyword', 'topic_group', 'cluster']), child_kind: z.enum(['keyword', 'topic_group', 'cluster']) })), topics: z.array(z.object({ topic_id: z.string(), relationship: z.string(), title_hint: z.string(), status: z.string() })), membership_next: z.object({ parent_id: z.string(), child_id: z.string() }).nullable(), topic_next: z.string().nullable() }), execute: async ({ reference, ...input }, context) => (await bound(context, false)).library.detail(reference, input) });
  register({ ...base, name: 'read_library_logs', capability: 'read', description: 'Read immutable human and AI change logs with exact before/after values and operation receipts.', inputSchema: logQuerySchema, outputSchema: z.object({ items: z.array(z.object({ id: z.string(), target_id: z.string(), action: z.string(), created_at: z.string(), reason: z.string(), actor: actorSchema, before: z.unknown(), after: z.unknown(), changes: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })), receipt })), next: z.object({ created_at: z.string(), id: z.string() }).nullable() }), execute: async (input, context) => (await bound(context, false)).library.logs(input) });
  for (const kind of ['keyword', 'topic_group', 'cluster'] as const) {
    const schema = dataSchemas[kind];
    const patchData = z.object(Object.fromEntries(Object.entries(schema.shape).map(([key, value]) => [key, value.removeDefault().optional()]))).strict();
    register({ ...base, name: `create_library_${kind}`, capability: 'write', replaySafety: 'idempotent', description: `Create a ${kind} in the bound language. Unknown research fields can remain empty. IDs, actor and operation identity are host-owned.`, inputSchema: z.object({ name: referenceSchema, data: schema, reason }).strict(), outputSchema: receipt,
      execute: async (input, context) => { const b = await bound(context, true); return b.library.create(kind, input.name, input.data, { operation_id: context.idempotencyKey, actor: b.actor, reason: input.reason }); } });
    register({ ...base, name: `revise_library_${kind}`, capability: 'write', replaySafety: 'idempotent', description: `Revise an observed ${kind}. Omitted fields stay unchanged; null clears nullable facts; [] clears a list. Supplied lists replace the field. Archive preserves references and logs; it does not cancel topics. Missing references never create entries.`, inputSchema: z.object({ reference: referenceSchema, name: referenceSchema.optional(), data: patchData.optional(), archived: z.boolean().optional(), reason }).strict(), outputSchema: receipt,
      execute: async (input, context) => { const b = await bound(context, true); const current = await b.library.get(input.reference); if (current.kind !== kind) throw new Error(`Reference is not a ${kind}`); return b.library.patch(input.reference, observed(b.observed, input.reference), { ...(input.name === undefined ? {} : { name: input.name }), ...(input.data === undefined ? {} : { data: input.data }), ...(input.archived === undefined ? {} : { archived: input.archived }) }, { operation_id: context.idempotencyKey, actor: b.actor, reason: input.reason }); } });
  }
  register({ ...base, name: 'organize_library_membership', capability: 'write', replaySafety: 'idempotent', description: 'Add or remove one topic-group/cluster membership between entries in this language. Multiple memberships are allowed. Does not create topics or decide content coverage.', inputSchema: z.object({ parent: referenceSchema, child: referenceSchema, present: z.boolean(), reason }).strict(), outputSchema: receipt,
    execute: async (input, context) => { const b = await bound(context, true); return b.library.membership(input.parent, input.child, input.present, { operation_id: context.idempotencyKey, actor: b.actor, reason: input.reason }); } });
  register({ ...base, name: 'relate_library_topic', capability: 'write', replaySafety: 'idempotent', description: 'Associate an existing site topic with a keyword in this language. Explain the relationship; null removes the association. Supports many keywords per topic and many topics per keyword; does not create or cancel topics.', inputSchema: z.object({ keyword: referenceSchema, topic: referenceSchema, relationship: referenceSchema.nullable(), reason }).strict(), outputSchema: receipt,
    execute: async (input, context) => { const b = await bound(context, true); return b.library.linkTopic(input.keyword, input.topic, input.relationship, { operation_id: context.idempotencyKey, actor: b.actor, reason: input.reason }); } });
  return registry;
}
