// @ts-ignore Node test-only module.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import { SiteProjection, PANEL_REFRESH_MS, REFRESH_QUIET_MS, REFRESH_MAX_WAIT_MS, isTopic } from './projection';
import { readAgentPanel, readAgentPanelTask } from '../team-status/panel';
import { attachTask } from '../agent-runtime/task-store';
import { getAgentRun } from '../agent-runtime/store';
import { agentDefinition, type AgentId } from '../agent-runtime/definitions';
import type { RuntimeAgentEnv } from '../agent-runtime/env';

function roomSql() {
  const db = new DatabaseSync(':memory:');
  return { exec: <T>(sql: string, ...params: unknown[]) => { const st = db.prepare(sql); return (/^\s*select/i.test(sql) ? st.all(...params as never[]) : (st.run(...params as never[]), [])) as T[]; } };
}

async function fixture() {
  const f = schemaTestDb();
  f.insert('sites', { id: 's', workspace_id: 'w', name: 'Site', ingest_url: 'https://example.invalid' });
  let clock = Date.UTC(2026, 0, 1);
  const room = new SiteProjection(roomSql(), { DB: f.db } as unknown as RuntimeAgentEnv, 's', 'v1', () => clock);
  const scope = { db: f.db, workspaceId: 'w', siteId: 's' };
  let n = 0;
  const task = async (agent: AgentId, extra: Record<string, unknown> = {}) => {
    const id = `run-${++n}`;
    const at = new Date(clock).toISOString();
    f.insert('agent_runs', { id, workspace_id: 'w', site_id: 's', agent_id: agent, agent_instance_id: id, definition_version: 1, prompt_version: 'p', trigger: 'manual', status: 'running', phase: 'running', root_run_id: id, summary_json: '{}', created_at: at, updated_at: at, ...extra });
    const saved = await attachTask(f.db, (await getAgentRun(f.db, id))!, agentDefinition(agent));
    return saved;
  };
  const progress = (taskId: string) => f.sqlite.prepare("insert into site_changes(workspace_id,site_id,kind,ref) values('w','s','task_progress',?)").run(taskId);
  return { ...f, room, scope, task, progress, tick: (ms: number) => { clock += ms; } };
}

describe('member panel topics', () => {
  it('accepts only roster agents and well-formed task topics', () => {
    expect(isTopic('panel:strategy_research')).toBe(true);
    expect(isTopic('panel:not_an_agent')).toBe(false);
    expect(isTopic('task:content_review:abc')).toBe(true);
    expect(isTopic('task:content_review:')).toBe(false);
  });

  it('keeps a task list equal to the HTTP view and ignores step progress', async () => {
    const f = await fixture();
    const first = await f.task('strategy_research');
    await f.room.subscribe('panel:strategy_research');
    expect(f.room.state('panel:strategy_research')!.data).toEqual(await readAgentPanel(f.scope, 'strategy_research'));
    const reads = () => f.executions('select id, agent_id, active_run_id, status, outcome, reason, agent_instance_id, parent_task_id, created_at, updated_at, goal_json');
    const before = reads();
    f.progress(first.id);
    expect(await f.room.catchUp()).toEqual([]);
    expect(reads()).toBe(before);
    f.tick(PANEL_REFRESH_MS);
    f.sqlite.prepare("update agent_tasks set status='completed',outcome='completed' where id=?").run(first.id);
    expect(await f.room.catchUp()).toEqual([]);
    f.tick(REFRESH_QUIET_MS);
    expect(await f.room.flushDue()).toEqual(['panel:strategy_research']);
    expect(f.room.state('panel:strategy_research')!.data).toEqual(await readAgentPanel(f.scope, 'strategy_research'));
  });

  it('rebuilds a task detail once per burst of changes, when they go quiet', async () => {
    const f = await fixture();
    const t = await f.task('deep_research');
    const topic = `task:deep_research:${t.id}`;
    await f.room.subscribe(topic);
    const reads = () => f.executions("from agent_task_operations where task_id=? and status != 'deciding'");
    const before = reads();
    f.tick(PANEL_REFRESH_MS);
    // One Agent step: several writes a second apart. Nothing is rebuilt while they continue.
    for (const reason of ['Reading sources', 'Reading more', 'Comparing']) {
      f.progress(t.id);
      f.sqlite.prepare('update agent_tasks set reason=? where id=?').run(reason, t.id);
      expect(await f.room.catchUp()).toEqual([]);
      f.tick(1000);
      expect(await f.room.flushDue()).toEqual([]);
    }
    expect(f.room.nextDue()).toBe(Date.UTC(2026, 0, 1) + PANEL_REFRESH_MS + 2000 + REFRESH_QUIET_MS);
    // Quiet: one rebuild, equal to the HTTP view.
    f.tick(REFRESH_QUIET_MS - 1000);
    expect(await f.room.flushDue()).toEqual([topic]);
    expect(reads()).toBe(before + 1);
    expect(f.room.state(topic)!.data).toEqual(await readAgentPanelTask(f.scope, 'deep_research', t.id));
    expect(f.room.nextDue()).toBeNull();
  });

  it('still updates a task whose changes never pause, and never within the minimum interval', async () => {
    const f = await fixture();
    const t = await f.task('deep_research');
    const topic = `task:deep_research:${t.id}`;
    await f.room.subscribe(topic);
    const rebuiltAt: number[] = [];
    for (let second = 1; second <= 40; second++) {
      f.tick(1000);
      f.progress(t.id);
      f.sqlite.prepare('update agent_tasks set reason=? where id=?').run(`Step ${second}`, t.id);
      await f.room.catchUp();
      if ((await f.room.flushDue()).length) rebuiltAt.push(second);
    }
    // Changes every second never go quiet: the first unshown change (seconds 1, then 17) waits at most the maximum.
    const wait = REFRESH_MAX_WAIT_MS / 1000;
    expect(rebuiltAt).toEqual([1 + wait, 17 + wait]);
    for (let i = 1; i < rebuiltAt.length; i++) expect((rebuiltAt[i] - rebuiltAt[i - 1]) * 1000).toBeGreaterThanOrEqual(PANEL_REFRESH_MS);
  });

  it('refreshes a parent detail when a child changes state', async () => {
    const f = await fixture();
    const parent = await f.task('content_production');
    const topic = `task:content_production:${parent.id}`;
    await f.room.subscribe(topic);
    f.tick(PANEL_REFRESH_MS);
    const child = await f.task('article_production');
    f.sqlite.prepare('update agent_tasks set parent_task_id=? where id=?').run(parent.id, child.id);
    f.sqlite.prepare("update agent_tasks set status='waiting',outcome='submitted' where id=?").run(child.id);
    await f.room.catchUp();
    f.tick(REFRESH_QUIET_MS);
    expect(await f.room.flushDue()).toContain(topic);
    expect(f.room.state(topic)!.data).toEqual(await readAgentPanelTask(f.scope, 'content_production', parent.id));
  });

  it('refuses a task of another agent', async () => {
    const f = await fixture();
    const t = await f.task('deep_research');
    expect(await f.room.subscribe(`task:strategy_research:${t.id}`)).toBeNull();
  });
});
