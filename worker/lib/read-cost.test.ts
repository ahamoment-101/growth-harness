// @ts-ignore Node test-only modules.
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { schemaTestDb } from './schema-test-db';
import { readAgentActivity } from '../team-status/activity';
import { readTeamStatus } from '../team-status';
import { readAgentPanel, readAgentPanelTask } from '../team-status/panel';
import { teamTaskFacts, workRequestFacts } from '../team-status/sources';
import { listConversations, readLeaderDetail, recoverLeaderDeliveries } from '../growth-leader/service';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { reconcileTaskExecutions } from '../agent-runtime/task-recovery';
import { reconcileFirecrawlCancellations } from '../agent-runtime/firecrawl-research';
import { countsForSites, getSiteByDomain, getSiteByRootDomain } from '../db';
import { SiteProjection } from '../site-room/projection';
import { dispatchPendingAgentEvents, pendingEventDeliveries } from '../agent-events/pool';
import { attachTask } from '../agent-runtime/task-store';
import { getAgentRun } from '../agent-runtime/store';
import { agentDefinition } from '../agent-runtime/definitions';
import { pokeChangedSites } from '../site-room/poke';
// @ts-ignore Node test-only module.
import { DatabaseSync as RoomDatabase } from 'node:sqlite';

function schemaDb() { return schemaTestDb(); }

// Tables that grow with usage. A full scan of any of them on a polled path costs a row per record per poll.
const growing = ['site_changes', 'leader_conversations', 'sites', 'firecrawl_research_jobs', 'agent_runtime_executions', 'topics', 'agent_tasks', 'agent_conversation_messages', 'agent_task_checkpoints', 'agent_task_operations', 'jobs', 'topic_decision_results', 'team_status_receipts', 'leader_inputs', 'agent_pool_events', 'agent_event_deliveries', 'agent_work_requests', 'agent_work_responses', 'agent_work_notes', 'content_production_groups', 'content_artifacts', 'seo_strategy_versions'];

function scans(sqlite: DatabaseSync, sql: string): string[] {
  const aliases = new Map<string, string>();
  for (const table of growing) {
    for (const m of sql.matchAll(new RegExp(`\\b${table}\\s+(?:as\\s+)?([a-z_]+)`, 'gi'))) aliases.set(m[1], table);
    aliases.set(table, table);
  }
  const plan = sqlite.prepare(`explain query plan ${sql}`).all() as Array<{ detail: string }>;
  // A partial index holds only rows matching its predicate (for example unfinished work), so walking it stays bounded.
  const partial = (detail: string) => {
    const index = detail.match(/USING (?:COVERING )?INDEX (\S+)/)?.[1];
    const row = index ? sqlite.prepare("select sql from sqlite_master where type='index' and name=?").get(index) as { sql?: string } | undefined : undefined;
    return !!row?.sql && /\swhere\s/i.test(row.sql);
  };
  return plan.map(p => p.detail).filter(detail => {
    if (partial(detail)) return false;
    const m = detail.match(/^SCAN (\S+)/);
    return !!m && aliases.has(m[1]) && !['where', 'on', 'join', 'and', 'order', 'group', 'limit', 'left'].includes(m[1].toLowerCase());
  });
}

describe('read cost of polled views', () => {
  it('never scans a growing table on polled views, per-minute recovery or public blog lookups', async () => {
    const { sqlite, seen, db, insert } = schemaDb();
    // A real conversation, so Leader reads run to completion instead of returning early.
    insert('sites', { id: 's', workspace_id: 'w', name: 'Site', ingest_url: 'https://example.invalid' });
    insert('leader_conversations', { id: 'c', workspace_id: 'w', site_id: 's', title: 'T', created_at: '2026-01-01' });
    // A real task, so the member panel detail read runs every query instead of returning early.
    insert('agent_runs', { id: 'r1', workspace_id: 'w', site_id: 's', agent_id: 'strategy_research', agent_instance_id: 'strategy:en', definition_version: 1, prompt_version: 'p', trigger: 'manual', status: 'running', phase: 'running', root_run_id: 'r1', summary_json: '{}', created_at: '2026-01-01', updated_at: '2026-01-01' });
    const panelTask = await attachTask(db, (await getAgentRun(db, 'r1'))!, agentDefinition('strategy_research'));
    seen.clear(); // Only the audited reads below count, not fixture writes.
    const scope = { db, workspaceId: 'w', siteId: 's' };
    const env = { DB: db } as unknown as RuntimeAgentEnv;

    await readAgentActivity(scope); await readTeamStatus(scope, ['strategy_research']); await readAgentPanel(scope, 'topic_decision');
    await listConversations(env, scope); await readLeaderDetail(env, scope, 'c');
    await recoverLeaderDeliveries(env); await dispatchPendingAgentEvents(env); await pendingEventDeliveries(db, {workspaceId:'w',siteId:'s',agentId:'growth_leader'}, 'publication:s');
    await reconcileTaskExecutions(env); await reconcileFirecrawlCancellations(env);
    const roomDb = new RoomDatabase(':memory:');
    const room = new SiteProjection({ exec: (sql: string, ...p: unknown[]) => { const st = roomDb.prepare(sql); return /^\s*select/i.test(sql) ? st.all(...p as never[]) as never[] : (st.run(...p as never[]), []); } }, env, 's', 'v1');
    for (const topic of ['team', 'activity', 'leader.list', 'leader.conv:c', 'panel:strategy_research', `task:strategy_research:${panelTask.id}`]) await room.subscribe(topic).catch(() => null);
    await room.catchUp();
    // First run only initializes the cursor; the second runs the per-minute range query.
    await pokeChangedSites(env); await pokeChangedSites(env);
    await getSiteByDomain(db, 'blog.example.com'); await getSiteByRootDomain(db, 'example.com'); await countsForSites(db, ['s']);
    // Re-reads by id must seek each id by primary key, never walk the site's tasks and filter.
    await teamTaskFacts(scope, ['t1', 't2']); await workRequestFacts(scope, ['t1']);
    expect([...seen].some(sql => sql.includes('from agent_task_operations where task_id=? and status !='))).toBe(true);
    const byId = [...seen].filter(sql => sql.includes('ids cross join agent_tasks t'));
    expect(byId.length).toBeGreaterThanOrEqual(2);
    for (const sql of byId) {
      const plan = (sqlite.prepare(`explain query plan ${sql}`).all() as Array<{ detail: string }>).map(p => p.detail);
      expect(plan.find(d => d.startsWith('SEARCH t ')), sql.slice(0, 80)).toMatch(/USING INDEX sqlite_autoindex_agent_tasks_1 \(id=\?\)/);
    }
    // The activity feed walks the site's timeline newest first and stops at a page: never per Agent (which
    // reads all their tasks to sort) and never through every operation of the site's tasks.
    const feed = (fragment: string) => [...seen].filter(sql => sql.includes(fragment)).map(sql =>
      (sqlite.prepare(`explain query plan ${sql}`).all() as Array<{ detail: string }>).map(p => p.detail).join(' | '));
    expect(feed("'0:start:'||t.id as event_id")).toEqual([expect.stringContaining('USING INDEX agent_tasks_site_created')]);
    expect(feed("'1:finish:'||t.id as event_id")).toEqual([expect.stringContaining('USING INDEX agent_tasks_site_status_updated')]);
    expect(feed("'1:delivery:'||c.id as event_id")).toEqual([expect.stringMatching(/agent_tasks_site_updated \(workspace_id=\? AND site_id=\? AND updated_at>\?\).*SEARCH o USING INDEX sqlite_autoindex_agent_task_operations_1 \(id=\?\)/)]);
    // Children of one parent are read through the parent index, never by walking the site's tasks.
    const byParent = [...seen].filter(sql => /ch\.parent_task_id=\(select id from agent_tasks where active_run_id=\?\)/.test(sql));
    expect(byParent.length).toBeGreaterThanOrEqual(1);
    for (const sql of byParent) {
      const plan = (sqlite.prepare(`explain query plan ${sql}`).all() as Array<{ detail: string }>).map(p => p.detail);
      expect(plan.find(d => d.startsWith('SEARCH ch ')), sql.slice(0, 80)).toMatch(/agent_tasks_parent/);
    }
        const offenders = [...seen].map(sql => ({ sql: sql.replace(/\s+/g, ' ').slice(0, 140), scans: scans(sqlite, sql) })).filter(item => item.scans.length);
    expect(offenders).toEqual([]);
  });

  // Member panels rebuild every few seconds while an Agent works. Besides full scans, a read must not seek
  // only by site (or site and Agent) without a limit: that walks the site's whole history on every rebuild.
  it('reads member panels without walking a site, an Agent or a task history', async () => {
    const { sqlite, seen, db, insert } = schemaDb();
    insert('sites', { id: 's', workspace_id: 'w', name: 'Site', ingest_url: 'https://example.invalid' });
    const scope = { db, workspaceId: 'w', siteId: 's' };
    const reads: Array<() => Promise<unknown>> = [];
    for (const agent of ['strategy_research', 'topic_decision', 'content_production', 'article_production', 'content_review', 'deep_research'] as const) {
      insert('agent_runs', { id: `r-${agent}`, workspace_id: 'w', site_id: 's', agent_id: agent, agent_instance_id: agent, definition_version: 1, prompt_version: 'p', trigger: 'manual', status: 'running', phase: 'running', root_run_id: `r-${agent}`, summary_json: '{}', created_at: '2026-01-01', updated_at: '2026-01-01' });
      const task = await attachTask(db, (await getAgentRun(db, `r-${agent}`))!, agentDefinition(agent));
      // A pending request, so the list also reads finished tasks that still await a person.
      insert('agent_work_requests', { task_id: task.id, request_id: 'q', handler_id: 'h', version: '1', state: 'pending', node_json: '{}', created_at: '2026-01-01', updated_at: '2026-01-01' });
      reads.push(() => readAgentPanel(scope, agent), () => readAgentPanelTask(scope, agent, task.id));
    }
    seen.clear();
    for (const read of reads) await read();
    const siteOnly = /^SEARCH \S+ USING (?:COVERING )?INDEX \S+ \(((?:workspace_id|site_id|agent_id)=\?(?: AND (?:workspace_id|site_id|agent_id)=\?)*)\)$/;
    const offenders = [...seen].flatMap(sql => {
      const plan = (sqlite.prepare(`explain query plan ${sql}`).all() as Array<{ detail: string }>).map(p => p.detail);
      const walks = /\blimit\b/i.test(sql) ? [] : plan.filter(detail => siteOnly.test(detail));
      return [...scans(sqlite, sql), ...walks].map(detail => `${detail} :: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
    });
    expect([...seen].some(sql => sql.includes('union select'))).toBe(true);
    // The work stream reads a page per source in index order; a full sort would read the task's whole history first.
    const stream = [...seen].filter(sql => /from agent_work_notes where task_id|from agent_task_operations o where o\.task_id/.test(sql));
    expect(stream).toHaveLength(2);
    for (const sql of stream) expect((sqlite.prepare(`explain query plan ${sql}`).all() as Array<{ detail: string }>).map(p => p.detail)).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    expect(offenders).toEqual([]);
  });
});
