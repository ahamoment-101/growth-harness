import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { agentRoster } from '../agent-runtime/definitions';
import { getConversation, listConversations, readLeaderDetail } from '../growth-leader/service';
import { readAgentActivity } from '../team-status/activity';
import { readAgentPanel, readAgentPanelTask } from '../team-status/panel';
import { teamStatusFromSignals } from '../team-status';
import { articleQueueFact, readTeamFacts, teamSignals, teamTaskFacts, topicQueueFact, workRequestFacts, type QueueFact, type TeamFacts, type WorkRequestFact } from '../team-status/sources';
import type { TaskFact } from '../team-status/task-rules';
import type { LeaderConversation } from '../../shared/growth-leader';
import type { AgentActivityPage } from '../../shared/agent-activity';

/** Synchronous SQL over the room's own storage (Durable Object `ctx.storage.sql`, or node:sqlite in tests). */
export type RoomSql = { exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] };
export type TopicState = { v: number; data: unknown };

/**
 * Live topics a page may subscribe to: `team`, `activity`, `leader.list`, `leader.conv:<conversation>`,
 * `panel:<agent>` (a member's task list) and `task:<agent>:<task>` (one task's detail).
 */
export const STATIC_TOPICS = ['team', 'activity', 'leader.list'] as const;
const CONVERSATION = 'leader.conv:';
const PANEL = 'panel:';
const TASK = 'task:';
const isAgent = (id: string) => agentRoster().some(agent => agent.agentId === id);
export function isTopic(name: string) {
  if (name.length >= 200) return false;
  if ((STATIC_TOPICS as readonly string[]).includes(name)) return true;
  if (name.startsWith(CONVERSATION)) return name.length > CONVERSATION.length;
  if (name.startsWith(PANEL)) return isAgent(name.slice(PANEL.length));
  if (name.startsWith(TASK)) { const [agent, task] = splitTask(name); return isAgent(agent) && !!task; }
  return false;
}
function splitTask(topic: string): [string, string] {
  const rest = topic.slice(TASK.length);
  const at = rest.indexOf(':');
  return at < 0 ? [rest, ''] : [rest.slice(0, at), rest.slice(at + 1)];
}
/**
 * Member panel topics read a lot per rebuild, so a change only marks them and the room's alarm rebuilds
 * them: once the changes have been quiet for REFRESH_QUIET_MS (an Agent step writes in a burst, which
 * then becomes one rebuild instead of one per write), at most REFRESH_MAX_WAIT_MS after the first change
 * not yet shown (a task that never pauses still updates), and never within PANEL_REFRESH_MS of the last rebuild.
 */
export const PANEL_REFRESH_MS = 5000;
export const REFRESH_QUIET_MS = 3000;
export const REFRESH_MAX_WAIT_MS = 15000;
/** When a marked topic is due, from its refresh row. */
const DUE = `max(last_at+${PANEL_REFRESH_MS},min(changed_at+${REFRESH_QUIET_MS},dirty_since+${REFRESH_MAX_WAIT_MS}))`;
const throttled = (topic: string) => topic.startsWith(PANEL) || topic.startsWith(TASK);

// The recent part of a Leader transcript kept live; earlier history is read over HTTP on demand.
const CONVERSATION_TAIL = 200;
const CHANGE_BATCH = 500;
const MILESTONE_OUTCOMES = ['completed', 'no_change', 'no_findings', 'awaiting_human_review'];

type Change = { seq: number; kind: string; ref: string };
type TaskRow = { id: string; agent_id: string; status: string; outcome: string; created_at: string; updated_at: string; active_run_id: string; parent_task_id: string; parent_agent_id: string; parent_run_id: string };

/**
 * A site's live read models, maintained from `site_changes` (docs/real-time-updates-and-cache-architecture.md §7).
 * Building a topic reads D1 once through the same functions the HTTP views use; afterwards each
 * change re-reads only the rows it names, so D1 reads follow changes, not viewers.
 */
export class SiteProjection {
  /**
   * `version` identifies the code that built the stored topics (the deploy version in production).
   * A different version drops them all, so a deploy never serves state shaped by older code.
   */
  constructor(private readonly sql: RoomSql, private readonly env: Pick<RuntimeAgentEnv, 'DB'>, private readonly siteId: string, version: string, private readonly now: () => number = Date.now) {
    sql.exec(`create table if not exists meta(key text primary key, value text not null)`);
    sql.exec(`create table if not exists topics(name text primary key, v integer not null, json text not null)`);
    sql.exec(`create table if not exists team_tasks(id text primary key, json text not null)`);
    sql.exec(`create table if not exists team_requests(task_id text primary key, json text not null)`);
    sql.exec(`create table if not exists team_queues(kind text primary key, json text not null)`);
    const upgraded = this.meta('version') !== version;
    // The refresh schedule's shape belongs to the code, so a new version recreates it.
    if (upgraded) sql.exec('drop table if exists refresh');
    sql.exec(`create table if not exists refresh(topic text primary key, last_at integer not null, changed_at integer, dirty_since integer)`);
    if (upgraded) {
      for (const topic of this.builtTopics()) this.drop(topic);
      this.setMeta('version', version);
    }
  }

  private get db() { return this.env.DB; }
  private meta(key: string): string | undefined { return this.sql.exec<{ value: string }>('select value from meta where key=?', key)[0]?.value; }
  private setMeta(key: string, value: string) { this.sql.exec('insert into meta(key,value) values(?,?) on conflict(key) do update set value=excluded.value', key, value); }

  private async scope() {
    let workspaceId = this.meta('workspace_id');
    if (!workspaceId) {
      const site = await this.db.prepare('select workspace_id from sites where id=?').bind(this.siteId).first<{ workspace_id: string }>();
      if (!site) throw new Error('Site not found');
      workspaceId = site.workspace_id;
      this.setMeta('workspace_id', workspaceId);
    }
    return { db: this.db, workspaceId, siteId: this.siteId };
  }

  state(topic: string): TopicState | null {
    const row = this.sql.exec<{ v: number; json: string }>('select v,json from topics where name=?', topic)[0];
    return row ? { v: row.v, data: JSON.parse(row.json) } : null;
  }
  /** Store a topic state; the version only moves when the content changed. */
  private save(topic: string, data: unknown): boolean {
    const json = JSON.stringify(data);
    const row = this.sql.exec<{ v: number; json: string }>('select v,json from topics where name=?', topic)[0];
    if (row?.json === json) return false;
    this.sql.exec('insert into topics(name,v,json) values(?,?,?) on conflict(name) do update set v=excluded.v,json=excluded.json', topic, (row?.v ?? 0) + 1, json);
    return true;
  }
  /** Forget a topic nobody watches; the next subscription rebuilds it from D1. */
  drop(topic: string) {
    this.sql.exec('delete from topics where name=?', topic);
    this.sql.exec('delete from refresh where topic=?', topic);
    if (topic === 'team') { this.sql.exec('delete from team_tasks'); this.sql.exec('delete from team_requests'); this.sql.exec('delete from team_queues'); }
  }
  builtTopics(): string[] { return this.sql.exec<{ name: string }>('select name from topics').map(row => row.name); }

  /** Current state of a topic, building it from D1 on first use. Null when it does not belong to this site. */
  async subscribe(topic: string): Promise<TopicState | null> {
    if (!isTopic(topic)) return null;
    await this.catchUp();
    const existing = this.state(topic);
    if (existing) return existing;
    const scope = await this.scope();
    if (topic === 'team') {
      const facts = await readTeamFacts(scope);
      this.storeTeamFacts(facts);
      this.save('team', this.teamState());
    } else {
      const data = await this.read(topic);
      if (data === null) return null;
      this.save(topic, data);
      if (throttled(topic)) this.rebuilt(topic);
    }
    return this.state(topic);
  }

  /** Full read of a topic from D1 through the HTTP view's own function. Null when it does not exist for this site. */
  private async read(topic: string): Promise<unknown> {
    const scope = await this.scope();
    const env = this.env as RuntimeAgentEnv;
    if (topic === 'activity') return readAgentActivity(scope);
    if (topic === 'leader.list') return { conversations: await listConversations(env, scope) };
    if (topic.startsWith(CONVERSATION)) return readLeaderDetail(env, scope, topic.slice(CONVERSATION.length), { tail: CONVERSATION_TAIL });
    if (topic.startsWith(PANEL)) return readAgentPanel(scope, topic.slice(PANEL.length));
    const [agent, task] = splitTask(topic);
    return readAgentPanelTask(scope, agent, task);
  }

  /** Mark a throttled topic changed; the room's alarm rebuilds it when due. */
  private mark(topic: string) {
    const now = this.now();
    this.sql.exec(`insert into refresh(topic,last_at,changed_at,dirty_since) values(?,0,?,?)
      on conflict(topic) do update set changed_at=excluded.changed_at,dirty_since=coalesce(dirty_since,excluded.dirty_since)`, topic, now, now);
  }
  private rebuilt(topic: string) {
    this.sql.exec(`insert into refresh(topic,last_at,changed_at,dirty_since) values(?,?,null,null)
      on conflict(topic) do update set last_at=excluded.last_at,changed_at=null,dirty_since=null`, topic, this.now());
  }
  private async rebuild(topic: string): Promise<boolean> {
    const data = await this.read(topic);
    this.rebuilt(topic);
    if (data === null) { this.drop(topic); return false; }
    return this.save(topic, data);
  }
  /** Earliest time a marked topic is due, for the room's alarm. */
  nextDue(): number | null {
    return this.sql.exec<{ due: number | null }>(`select min(${DUE}) as due from refresh where dirty_since is not null`)[0]?.due ?? null;
  }
  /** Rebuild every marked topic that is due. Returns the topics whose state changed. */
  async flushDue(): Promise<string[]> {
    const due = this.sql.exec<{ topic: string }>(`select topic from refresh where dirty_since is not null and ${DUE}<=?`, this.now());
    const changed: string[] = [];
    for (const { topic } of due) if (await this.rebuild(topic)) changed.push(topic);
    return changed;
  }

  /**
   * Change rows read by every catch-up on this instance, including those run inside `subscribe`
   * (for the room's operational log; the room makes a fresh instance per action).
   */
  processed = 0;

  /** Apply every change after the last applied one. Returns topics whose state changed. Idempotent. */
  async catchUp(): Promise<string[]> {
    let applied = Number(this.meta('applied_seq') ?? NaN);
    if (!Number.isFinite(applied)) {
      // A new room starts at the present; topics are built from D1 when first subscribed.
      const row = await this.db.prepare('select coalesce(max(seq),0) as seq from site_changes where site_id=?').bind(this.siteId).first<{ seq: number }>();
      applied = Number(row?.seq ?? 0);
      this.setMeta('applied_seq', String(applied));
    }
    const changed = new Set<string>();
    for (;;) {
      const batch = (await this.db.prepare('select seq,kind,ref from site_changes where site_id=? and seq>? order by seq limit ?')
        .bind(this.siteId, applied, CHANGE_BATCH).all<Change>()).results;
      if (!batch.length) break;
      this.processed += batch.length;
      if (this.builtTopics().length) for (const topic of await this.apply(batch)) changed.add(topic);
      applied = batch[batch.length - 1].seq;
      this.setMeta('applied_seq', String(applied));
      if (batch.length < CHANGE_BATCH) break;
    }
    return [...changed];
  }

  private async apply(changes: Change[]): Promise<string[]> {
    const refs = (...kinds: string[]) => [...new Set(changes.filter(c => kinds.includes(c.kind)).map(c => c.ref))];
    const tasks = refs('task'), receipts = refs('receipt'), requests = refs('work_request'), checkpoints = refs('checkpoint'), progress = refs('task_progress');
    const conversations = new Set(refs('leader_message', 'leader_input', 'leader_conversation'));
    const jobs = changes.some(c => c.kind === 'job'), topics = changes.some(c => c.kind === 'topic_result');
    const scope = await this.scope();
    const built = new Set(this.builtTopics());
    const changed: string[] = [];

    const touched = [...new Set([...tasks, ...requests, ...checkpoints, ...receipts, ...progress])];
    const rows = touched.length ? (await this.db.prepare(`select t.id,t.agent_id,t.status,t.outcome,t.created_at,t.updated_at,t.active_run_id,t.parent_task_id,
        coalesce(p.agent_id,'') as parent_agent_id,coalesce(p.active_run_id,'') as parent_run_id
      from json_each(?) ids cross join agent_tasks t on t.id=ids.value left join agent_tasks p on p.id=t.parent_task_id
      where t.workspace_id=? and t.site_id=?`).bind(JSON.stringify(touched), scope.workspaceId, scope.siteId).all<TaskRow>()).results : [];

    // Progress rows (anything a running step wrote) only move task details; every other view follows state changes.
    const stateful = new Set([...tasks, ...requests, ...checkpoints, ...receipts]);
    const stateRows = rows.filter(row => stateful.has(row.id));

    if (built.has('team')) {
      const ids = [...new Set([...tasks, ...receipts, ...requests])];
      if (ids.length) {
        const facts = await teamTaskFacts(scope, ids);
        const pending = await workRequestFacts(scope, ids);
        this.sql.exec('delete from team_tasks where id in (select value from json_each(?))', JSON.stringify(ids));
        this.sql.exec('delete from team_requests where task_id in (select value from json_each(?))', JSON.stringify(ids));
        for (const fact of facts) this.sql.exec('insert into team_tasks(id,json) values(?,?)', fact.id, JSON.stringify(fact));
        for (const request of pending) this.sql.exec('insert into team_requests(task_id,json) values(?,?)', request.task_id, JSON.stringify(request));
      }
      if (jobs) this.setQueue('articles', await articleQueueFact(scope));
      if (topics) this.setQueue('topics', await topicQueueFact(scope));
      if (this.save('team', this.teamState())) changed.push('team');
    }

    if (built.has('activity') && this.activityMayChange(stateRows, checkpoints)) {
      if (this.save('activity', await readAgentActivity(scope))) changed.push('activity');
    }

    // Leader views: the Leader's own tasks map to their conversation, delegated tasks to their parent's.
    const delegated = stateRows.filter(row => row.parent_agent_id === 'growth_leader');
    for (const row of stateRows) if (row.agent_id === 'growth_leader' && row.active_run_id) conversations.add(row.active_run_id);
    for (const row of delegated) if (row.parent_run_id) conversations.add(row.parent_run_id);
    // Attention on delegated work can change with any request, article or topic queue movement.
    const attention = jobs || topics || requests.length > 0;

    if (built.has('leader.list') && conversations.size) {
      const list = this.state('leader.list')!.data as { conversations: LeaderConversation[] };
      let items = list.conversations;
      for (const id of conversations) {
        const next = await getConversation(this.env as RuntimeAgentEnv, scope, id);
        items = items.filter(item => item.id !== id);
        if (next) items.push(next);
      }
      items.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
      if (this.save('leader.list', { conversations: items })) changed.push('leader.list');
    }

    for (const topic of built) {
      if (!topic.startsWith(CONVERSATION)) continue;
      const id = topic.slice(CONVERSATION.length);
      if (!conversations.has(id) && !attention) continue;
      const detail = await readLeaderDetail(this.env as RuntimeAgentEnv, scope, id, { tail: CONVERSATION_TAIL });
      if (!detail) { this.drop(topic); continue; }
      if (this.save(topic, detail)) changed.push(topic);
    }

    // Member panels: a task list moves with its agent's task state, requests and read receipts; a
    // task detail with anything logged for that task or its children. Queues feed the review agents.
    const listed = new Set(stateRows.map(row => row.agent_id));
    if (jobs) listed.add('content_production');
    if (topics) listed.add('topic_decision');
    const details = new Set([...tasks, ...progress, ...requests, ...receipts, ...checkpoints]);
    for (const row of rows) if (row.parent_task_id && tasks.includes(row.id)) details.add(row.parent_task_id);
    for (const topic of built) {
      let affected = false;
      if (topic.startsWith(PANEL)) affected = listed.has(topic.slice(PANEL.length));
      else if (topic.startsWith(TASK)) {
        const [agent, task] = splitTask(topic);
        affected = details.has(task) || (jobs && agent === 'content_production') || (topics && agent === 'topic_decision');
      }
      if (affected) this.mark(topic);
    }
    return changed;
  }

  /**
   * Only a milestone the feed does not show yet moves it: a start, a qualifying completion, or a
   * delivery. Other state changes of recent tasks (running ↔ waiting, reasons) must not rebuild it.
   */
  private activityMayChange(rows: TaskRow[], checkpoints: string[]): boolean {
    const page = this.state('activity')!.data as AgentActivityPage;
    const oldest = page.entries.length >= 40 ? page.entries[page.entries.length - 1].at : '';
    const shown = new Set(page.entries.map(entry => entry.id));
    const roster = new Set(agentRoster().map(agent => agent.agentId as string));
    return rows.some(row => roster.has(row.agent_id) && (
      (row.created_at >= oldest && !shown.has(`0:start:${row.id}`))
      || (row.status === 'completed' && MILESTONE_OUTCOMES.includes(row.outcome) && row.updated_at >= oldest && !shown.has(`1:finish:${row.id}`))
      || (checkpoints.includes(row.id) && (row.agent_id === 'article_production' || row.agent_id === 'content_review'))));
  }

  private setQueue(kind: 'articles' | 'topics', fact: QueueFact) {
    this.sql.exec('insert into team_queues(kind,json) values(?,?) on conflict(kind) do update set json=excluded.json', kind, JSON.stringify(fact));
  }
  private storeTeamFacts(facts: TeamFacts) {
    this.sql.exec('delete from team_tasks'); this.sql.exec('delete from team_requests');
    for (const fact of facts.tasks) this.sql.exec('insert into team_tasks(id,json) values(?,?)', fact.id, JSON.stringify(fact));
    for (const request of facts.requests) this.sql.exec('insert into team_requests(task_id,json) values(?,?)', request.task_id, JSON.stringify(request));
    this.setQueue('articles', facts.articles);
    this.setQueue('topics', facts.topics);
  }
  private teamState() {
    const parse = <T>(rows: Array<{ json: string }>) => rows.map(row => JSON.parse(row.json) as T);
    const queues = new Map(this.sql.exec<{ kind: string; json: string }>('select kind,json from team_queues').map(row => [row.kind, JSON.parse(row.json) as QueueFact]));
    const facts: TeamFacts = {
      tasks: parse<TaskFact>(this.sql.exec('select json from team_tasks order by id')),
      requests: parse<WorkRequestFact>(this.sql.exec('select json from team_requests order by task_id')),
      articles: queues.get('articles') ?? { count: 0, at: '' },
      topics: queues.get('topics') ?? { count: 0, at: '' },
    };
    // Leader conversation standby is not a human request; its durable requests still need attention.
    const signals = teamSignals(facts).filter(signal => signal.agent_id !== 'growth_leader' || signal.reason === 'work_request');
    return teamStatusFromSignals(signals, [...agentRoster().map(member => member.agentId), 'growth_leader']);
  }
}
