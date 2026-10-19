import { ToolContractError } from '../agent-runtime/tool-failure';
import { actorSchema, dataSchemas, detailQuerySchema, kindSchema, listSchema, logQuerySchema, referenceSchema, scopeSchema, type Actor, type Kind, type Scope } from './contracts';

export type Entry = {
  id: string; kind: Kind; name: string; data: Record<string, unknown>;
  revision: number; archived: boolean; created_at: string; updated_at: string;
};
type Row = Omit<Entry, 'data' | 'archived'> & { data_json: string; archived: number };
type WriteContext = { operation_id: string; actor: Actor; reason: string };
/** related lists other entries whose revision the same write advanced, so callers can keep working without a reread. */
export type Receipt = { log_id: string; target_id: string; revision: number; changed: boolean; related?: Array<{ id: string; revision: number }> };
const serialize = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const decode = (row: Row): Entry => ({ id: row.id, kind: row.kind, name: row.name, data: JSON.parse(row.data_json), revision: row.revision, archived: !!row.archived, created_at: row.created_at, updated_at: row.updated_at });
function fail(path: string, message: string, kind: 'invalid_request' | 'state_conflict' = 'invalid_request'): never {
  throw new ToolContractError(message, { kind, issues: [{ path: [path], message }], effects: 'none', guidance: 'Use the scoped references and observed revision returned by library reads.' });
}

/** Domain service. Caller supplies authenticated identity and a fenced DB for agent writes. */
export class KeywordLibrary {
  readonly scope: Scope;
  constructor(private readonly db: D1Database, scope: Scope) { this.scope = scopeSchema.parse(scope); }
  private scopeValues() { const s = this.scope; return [s.workspace_id, s.site_id, s.locale]; }
  private where = 'workspace_id=? and site_id=? and locale=?';
  private async authorize() {
    const site = await this.db.prepare('select id from sites where workspace_id=? and id=?')
      .bind(this.scope.workspace_id, this.scope.site_id).first();
    if (!site) fail('site_id', 'Site is not in the authenticated workspace');
  }
  async get(id: string): Promise<Entry> {
    await this.authorize();
    referenceSchema.parse(id);
    const row = await this.db.prepare(`select * from keyword_library_entries where ${this.where} and id=?`)
      .bind(...this.scopeValues(), id).first<Row>();
    if (!row) fail('reference', `Library reference is not present in this language: ${id}`);
    return decode(row);
  }
  /** Exact identity by name: names are unique per language and kind after NFC normalization and lowercasing. */
  async getByName(kind: Kind, name: string): Promise<Entry> {
    await this.authorize();
    const normalized = referenceSchema.parse(name).normalize('NFC').toLowerCase();
    const row = await this.db.prepare(`select * from keyword_library_entries where ${this.where} and kind=? and normalized_name=?`)
      .bind(...this.scopeValues(), kindSchema.parse(kind), normalized).first<Row>();
    if (!row) fail('reference', `No ${kind} named "${name}" is present in this language`);
    return decode(row);
  }
  async detail(id: string, input: unknown = {}) {
    const entry = await this.get(id);
    const q = detailQuerySchema.parse(input);
    const memberships = await this.db.prepare(`select parent_id,child_id,parent_kind,child_kind from keyword_library_memberships where ${this.where} and (parent_id=? or child_id=?)
      ${q.membership_after ? 'and (parent_id>? or (parent_id=? and child_id>?))' : ''} order by parent_id,child_id limit ?`)
      .bind(...this.scopeValues(), id, id, ...(q.membership_after ? [q.membership_after.parent_id, q.membership_after.parent_id, q.membership_after.child_id] : []), q.limit + 1).all<{ parent_id: string; child_id: string; parent_kind: Kind; child_kind: Kind }>();
    const topics = await this.db.prepare(`select l.topic_id,l.relationship,t.title_hint,t.status from keyword_library_topic_links l join topics t on t.id=l.topic_id and t.site_id=l.site_id where l.workspace_id=? and l.site_id=? and l.locale=? and l.keyword_id=?
      ${q.topic_after ? 'and l.topic_id>?' : ''} order by l.topic_id limit ?`)
      .bind(...this.scopeValues(), id, ...(q.topic_after ? [q.topic_after] : []), q.limit + 1).all<{ topic_id: string; relationship: string; title_hint: string; status: string }>();
    const members = memberships.results.slice(0, q.limit);
    const linked = topics.results.slice(0, q.limit);
    const last = members.at(-1);
    return { entry, memberships: members, topics: linked,
      membership_next: memberships.results.length > q.limit && last ? { parent_id: last.parent_id, child_id: last.child_id } : null,
      topic_next: topics.results.length > q.limit ? linked.at(-1)!.topic_id : null,
    };
  }
  async list(input: unknown = {}) {
    await this.authorize();
    const q = listSchema.parse(input);
    const clauses = [this.where, 'archived=?']; const args: unknown[] = [...this.scopeValues(), Number(q.archived)];
    if (q.kind) { clauses.push('kind=?'); args.push(q.kind); }
    if (q.query) { clauses.push('instr(normalized_name,?)>0'); args.push(q.query.normalize('NFC').toLowerCase()); }
    if (q.after) { clauses.push('id>?'); args.push(q.after); }
    if (q.parent_id) { await this.get(q.parent_id); clauses.push('id in (select child_id from keyword_library_memberships where parent_id=? union select b.child_id from keyword_library_memberships a join keyword_library_memberships b on a.child_id=b.parent_id where a.parent_id=?)'); args.push(q.parent_id, q.parent_id); }
    if (q.intent) { clauses.push("exists(select 1 from json_each(data_json,'$.intents') where value=?)"); args.push(q.intent); }
    const rows = await this.db.prepare(`select * from keyword_library_entries where ${clauses.join(' and ')} order by id limit ?`).bind(...args, q.limit + 1).all<Row>();
    const items = rows.results.slice(0, q.limit).map(decode);
    return { items, next: rows.results.length > q.limit ? items.at(-1)!.id : null };
  }
  async logs(input: unknown = {}) {
    await this.authorize();
    const q = logQuerySchema.parse(input); const clauses = [this.where]; const args: unknown[] = [...this.scopeValues()];
    if (q.target_id) { clauses.push("(target_id=? or json_extract(after_json,'$.child_id')=?)"); args.push(q.target_id, q.target_id); }
    if (q.actor_type) { clauses.push("json_extract(actor_json,'$.type')=?"); args.push(q.actor_type); }
    if (q.before) { clauses.push('(created_at<? or (created_at=? and id<?))'); args.push(q.before.created_at, q.before.created_at, q.before.id); }
    const result = await this.db.prepare(`select * from keyword_library_logs where ${clauses.join(' and ')} order by created_at desc,id desc limit ?`).bind(...args, q.limit + 1).all<Record<string, unknown>>();
    const items = result.results.slice(0, q.limit).map((r) => ({ id: String(r.id), target_id: String(r.target_id), action: String(r.action), created_at: String(r.created_at), reason: String(r.reason), actor: JSON.parse(String(r.actor_json)), before: JSON.parse(String(r.before_json)), after: JSON.parse(String(r.after_json)), changes: JSON.parse(String(r.changes_json)), receipt: JSON.parse(String(r.receipt_json)) }));
    const last = items.at(-1);
    return { items, next: result.results.length > q.limit && last ? { created_at: last.created_at, id: last.id } : null };
  }
  private async replay(context: WriteContext, request: unknown): Promise<Receipt | null> {
    await this.authorize(); referenceSchema.parse(context.operation_id); actorSchema.parse(context.actor);
    if (typeof context.reason !== 'string') fail('reason', 'A business change summary is required');
    const row = await this.db.prepare(`select request_json,actor_json,receipt_json from keyword_library_logs where ${this.where} and operation_id=?`)
      .bind(...this.scopeValues(), context.operation_id).first<{ request_json: string; actor_json: string; receipt_json: string }>();
    if (!row) return null;
    if (row.request_json !== serialize(request) || row.actor_json !== serialize(context.actor)) fail('operation_id', 'Operation identity was already used with different input or actor', 'state_conflict');
    return JSON.parse(row.receipt_json);
  }
  private async commit(context: WriteContext, request: unknown, action: string, target: string, before: unknown, after: unknown, revision: number, mutation: D1PreparedStatement, extra: D1PreparedStatement[] = [], related?: Receipt['related']): Promise<Receipt> {
    const receipt: Receipt = { log_id: crypto.randomUUID(), target_id: target, revision, changed: serialize(before) !== serialize(after), ...(related ? { related } : {}) };
    const old = (before || {}) as Record<string, unknown>; const next = (after || {}) as Record<string, unknown>;
    const changes = [...new Set([...Object.keys(old), ...Object.keys(next)])].filter((key) => serialize(old[key] ?? null) !== serialize(next[key] ?? null))
      .map((field) => ({ field, before: old[field] ?? null, after: next[field] ?? null }));
    // This statement must immediately follow the CAS mutation. A zero-row update fails
    // NOT NULL, rolling the whole D1 batch back, including the log and relation effects.
    const log = this.db.prepare(`insert into keyword_library_logs
      (id,workspace_id,site_id,locale,operation_id,request_json,actor_json,action,target_id,before_json,after_json,changes_json,receipt_json,reason,created_at)
      values(CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(receipt.log_id, ...this.scopeValues(), context.operation_id, serialize(request), serialize(context.actor), action, target, serialize(before), serialize(after), serialize(changes), serialize(receipt), context.reason, new Date().toISOString());
    try { await this.db.batch([mutation, log, ...extra]); } catch (error) {
      const replayed = await this.replay(context, request); if (replayed) return replayed;
      if (/constraint|keyword_library_logs\.id/i.test(String(error))) fail('revision_or_reference', 'State changed, a scoped relationship is invalid, or this name already exists', 'state_conflict');
      throw error;
    }
    return receipt;
  }
  async create(kind: Kind, name: string, data: unknown, context: WriteContext): Promise<Receipt> {
    kindSchema.parse(kind); name = referenceSchema.parse(name).normalize('NFC');
    const parsed = dataSchemas[kind].parse(data); const request = { action: 'create', kind, name, data: parsed, reason: context.reason };
    const prior = await this.replay(context, request); if (prior) return prior;
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    const after = { name, ...parsed, archived: false };
    return this.commit(context, request, `create_${kind}`, id, null, after, 1,
      this.db.prepare(`insert into keyword_library_entries(id,workspace_id,site_id,locale,kind,name,normalized_name,data_json,revision,created_at,updated_at) values(?,?,?,?,?,?,?,?,1,?,?)`)
        .bind(id, ...this.scopeValues(), kind, name, name.toLowerCase(), serialize(parsed), now, now));
  }
  async patch(id: string, revision: number, patch: { name?: string; data?: Record<string, unknown>; archived?: boolean }, context: WriteContext): Promise<Receipt> {
    const request = { action: 'patch', id, revision, patch, reason: context.reason };
    const prior = await this.replay(context, request); if (prior) return prior;
    const current = await this.get(id);
    if (!Number.isInteger(revision) || revision < 1) fail('revision', 'Expected a positive observed revision');
    if (current.revision !== revision) fail('revision', `Observed revision ${revision} differs from current revision ${current.revision}`, 'state_conflict');
    if (Object.keys(patch).some((k) => !['name', 'data', 'archived'].includes(k))) fail('patch', 'Unknown patch field');
    if (patch.archived !== undefined && typeof patch.archived !== 'boolean') fail('archived', 'Expected boolean');
    const name = patch.name === undefined ? current.name : referenceSchema.parse(patch.name).normalize('NFC');
    const data = dataSchemas[current.kind].parse({ ...current.data, ...patch.data });
    const archived = patch.archived ?? current.archived;
    return this.commit(context, request, `update_${current.kind}`, id,
      { name: current.name, ...current.data, archived: current.archived }, { name, ...data, archived }, revision + 1,
      this.db.prepare(`update keyword_library_entries set name=?,normalized_name=?,data_json=?,archived=?,revision=revision+1,updated_at=? where ${this.where} and id=? and revision=?`)
        .bind(name, name.toLowerCase(), serialize(data), Number(archived), new Date().toISOString(), ...this.scopeValues(), id, revision));
  }
  // Relationship writes are independent rows that can be repeated safely, so they do not require an
  // observed revision. They still advance both entries' revisions, which fence later content revisions.
  async membership(parentId: string, childId: string, present: boolean, context: WriteContext): Promise<Receipt> {
    const request = { action: 'membership', parentId, childId, present, reason: context.reason };
    const prior = await this.replay(context, request); if (prior) return prior;
    const parent = await this.get(parentId); const child = await this.get(childId);
    if (!((parent.kind === 'topic_group' && ['cluster', 'keyword'].includes(child.kind)) || (parent.kind === 'cluster' && child.kind === 'keyword'))) fail('relationship', 'Expected topic group → cluster/keyword or cluster → keyword');
    if (present && (parent.archived || child.archived)) fail('reference', 'Cannot add membership to archived entries', 'state_conflict');
    const existing = await this.db.prepare('select parent_id from keyword_library_memberships where parent_id=? and child_id=?').bind(parentId, childId).first();
    const now = new Date().toISOString();
    const mutation = this.db.prepare(`update keyword_library_entries set revision=revision+1,updated_at=? where ${this.where} and id=? and exists(select 1 from keyword_library_entries where ${this.where} and id=?)`)
      .bind(now, ...this.scopeValues(), parentId, ...this.scopeValues(), childId);
    const relation = present ? this.db.prepare(`insert into keyword_library_memberships(parent_id,child_id,workspace_id,site_id,locale,parent_kind,child_kind) values(?,?,?,?,?,?,?) on conflict(parent_id,child_id) do nothing`).bind(parentId, childId, ...this.scopeValues(), parent.kind, child.kind)
      : this.db.prepare('delete from keyword_library_memberships where parent_id=? and child_id=?').bind(parentId, childId);
    return this.commit(context, request, present ? 'add_membership' : 'remove_membership', parentId,
      { parent_id: parentId, child_id: childId, present: !!existing }, { parent_id: parentId, child_id: childId, present }, parent.revision + 1, mutation, [relation, this.db.prepare(`update keyword_library_entries set revision=revision+1,updated_at=? where ${this.where} and id=?`).bind(now, ...this.scopeValues(), childId)],
      [{ id: childId, revision: child.revision + 1 }]);
  }
  async linkTopic(keywordId: string, topicId: string, relationship: string | null, context: WriteContext): Promise<Receipt> {
    const request = { action: 'topic_link', keywordId, topicId, relationship, reason: context.reason };
    const prior = await this.replay(context, request); if (prior) return prior;
    const keyword = await this.get(keywordId);
    if (keyword.kind !== 'keyword') fail('keyword_id', 'Topic links require a keyword');
    if (relationship !== null) { referenceSchema.parse(relationship); if (keyword.archived) fail('keyword_id', 'Keyword is archived', 'state_conflict'); }
    const topic = await this.db.prepare('select id,plan_json from topics where site_id=? and id=?').bind(this.scope.site_id, topicId).first<{id:string;plan_json:string}>();
    if (!topic) fail('topic_id', 'Topic does not belong to this site');
    const plan = JSON.parse(topic.plan_json || '{}') as { locale?: string };
    if (relationship !== null && plan.locale && (plan.locale !== this.scope.locale)) fail('topic_id', 'Topic belongs to a different language');
    const existing = await this.db.prepare('select relationship from keyword_library_topic_links where keyword_id=? and topic_id=?').bind(keywordId, topicId).first<{ relationship: string }>();
    const mutation = this.db.prepare(`update keyword_library_entries set revision=revision+1,updated_at=? where ${this.where} and id=?`).bind(new Date().toISOString(), ...this.scopeValues(), keywordId);
    const link = relationship === null ? this.db.prepare('delete from keyword_library_topic_links where keyword_id=? and topic_id=?').bind(keywordId, topicId)
      : this.db.prepare(`insert into keyword_library_topic_links(keyword_id,topic_id,workspace_id,site_id,locale,relationship) values(?,?,?,?,?,?) on conflict(keyword_id,topic_id) do update set relationship=excluded.relationship`).bind(keywordId, topicId, ...this.scopeValues(), relationship);
    return this.commit(context, request, relationship === null ? 'unlink_topic' : 'link_topic', keywordId,
      { topic_id: topicId, relationship: existing?.relationship ?? null }, { topic_id: topicId, relationship }, keyword.revision + 1, mutation, [link]);
  }
}
