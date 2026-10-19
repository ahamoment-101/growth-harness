import { describe, expect, it } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { attachTask } from '../agent-runtime/task-store';
import { agentDefinition } from '../agent-runtime/definitions';
import { activityCursor, readAgentActivity } from './activity';

async function fixture() {
  const f = taskTestDb();
  f.sqlite.exec('create table team_status_receipts(workspace_id text,site_id text,agent_id text,task_id text,completed_at text)');
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  return { ...f, task, scope: { db: f.db, workspaceId: 'w', siteId: 's' } };
}

describe('Agent activity milestones', () => {
  it('keeps the start and adds completion only for a confirmed successful outcome', async () => {
    const f = await fixture();
    expect((await readAgentActivity(f.scope)).entries).toEqual([expect.objectContaining({ kind: 'started', agent_name: 'Strategist', title: 'started English market · SEO Strategy' })]);
    for (const [status, outcome] of [['waiting', 'submitted'], ['paused', 'external_pending'], ['failed', 'execution_failed'], ['completed', 'unable_to_complete'], ['completed', 'partial']]) {
      f.sqlite.prepare('update agent_tasks set status=?,outcome=? where id=?').run(status, outcome, f.task.id);
      expect((await readAgentActivity(f.scope)).entries.map(entry => entry.kind)).toEqual(['started']);
    }
    f.sqlite.prepare("update agent_tasks set status='completed',outcome='completed',updated_at='2099-01-01T00:00:00Z' where id=?").run(f.task.id);
    expect((await readAgentActivity(f.scope)).entries.map(entry => entry.kind)).toEqual(['completed', 'started']);
    expect((await readAgentActivity({ ...f.scope, siteId: 'other' })).entries).toEqual([]);
    expect((await readAgentActivity({ ...f.scope, workspaceId: 'other' })).entries).toEqual([]);
    expect((await readAgentActivity(f.scope, '', 'runtime_synthetic')).entries).toEqual([]);
  });
  it('paginates equal timestamps without duplicates or omissions', async () => {
    const f = await fixture();
    for (let i = 0; i < 45; i++) await attachTask(f.db, f.run(`run-${i + 2}`, `strategy:${i}`), agentDefinition('strategy_research'));
    f.sqlite.exec("update agent_tasks set created_at='2026-09-20T00:00:00Z'");
    const first = await readAgentActivity(f.scope);
    const second = await readAgentActivity(f.scope, first.next_cursor!);
    expect(first.entries).toHaveLength(40);
    expect(second.entries).toHaveLength(6);
    expect(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size).toBe(46);
    expect(second.next_cursor).toBeNull();
  });
  it('preserves delivered work after a child resumes and excludes deferred checkpoints', async () => {
    const f = await fixture();
    f.sqlite.prepare("update agent_tasks set agent_id='content_review',goal_json='{}' where id=?").run(f.task.id);
    for (const [id, name] of [['review', 'submit_content_review'], ['defer', 'defer_content_review']]) {
      f.sqlite.prepare("insert into agent_task_operations(id,task_id,turn,status,context_json,action_json,created_at,updated_at) values(?,?,?,'succeeded','{}',?,'2026-09-20','2026-09-20')").run(id, f.task.id, id === 'review' ? 1 : 2, JSON.stringify({ name }));
      f.sqlite.prepare("insert into agent_task_checkpoints(id,task_id,operation_id,assignment_id,output_json,created_at) values(?,?,?,'assignment','{}','2026-09-20')").run(id, f.task.id, id);
    }
    const entries = (await readAgentActivity(f.scope)).entries;
    expect(entries.filter(entry => entry.kind === 'completed')).toEqual([expect.objectContaining({ id: '1:delivery:review', agent_name: 'Reviewer' })]);
  });
  it('pages deliveries beyond the first page of starts without omissions', async () => {
    const f = await fixture();
    f.sqlite.prepare("update agent_tasks set agent_id='content_review',goal_json='{}',created_at='2026-01-01T00:00:00Z' where id=?").run(f.task.id);
    // 60 reviews; each delivers an hour after it starts, stamping the task like finishTaskTerminal does.
    for (let i = 0; i < 60; i++) {
      const task = await attachTask(f.db, f.run(`run-${i + 2}`, `review:${i}`), agentDefinition('strategy_research'));
      const start = new Date(Date.UTC(2026, 1, 1, i)).toISOString(), done = new Date(Date.UTC(2026, 1, 1, i + 1, 30)).toISOString();
      f.sqlite.prepare("update agent_tasks set agent_id='content_review',goal_json='{}',created_at=?,updated_at=? where id=?").run(start, done, task.id);
      f.sqlite.prepare("insert into agent_task_operations(id,task_id,turn,status,context_json,action_json,created_at,updated_at) values(?,?,1,'succeeded','{}',?,?,?)").run(`op-${i}`, task.id, JSON.stringify({ name: 'submit_content_review' }), done, done);
      f.sqlite.prepare("insert into agent_task_checkpoints(id,task_id,operation_id,assignment_id,output_json,created_at) values(?,?,?,'a','{}',?)").run(`op-${i}`, task.id, `op-${i}`, done);
    }
    const seen: Array<{ id: string; at: string }> = [];
    let cursor = '';
    do {
      const page = await readAgentActivity(f.scope, cursor);
      seen.push(...page.entries.map(entry => ({ id: entry.id, at: entry.at })));
      cursor = page.next_cursor || '';
    } while (cursor);
    expect(seen.filter(entry => entry.id.startsWith('1:delivery:'))).toHaveLength(60);
    expect(seen.filter(entry => entry.id.startsWith('0:start:'))).toHaveLength(61);
    expect(new Set(seen.map(entry => entry.id)).size).toBe(seen.length);
    expect(seen.map(entry => entry.at)).toEqual(seen.map(entry => entry.at).sort().reverse());
  });
  it('rejects malformed cursors', () => {
    for (const value of ['{}', '[1,2]', '["x"]', 'bad']) expect(() => activityCursor(value)).toThrow();
  });
});
