import { describe, expect, it, vi } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { attachTask, stopTask, taskForRun } from '../agent-runtime/task-store';
import { agentDefinition } from '../agent-runtime/definitions';
import { createWorkRequest, pendingWork, respondToWork, workInteractions } from './index';
import { runtimeTasks } from '../team-status/sources';
import { runtimeWorkProvider } from './runtime-provider';
import { readWorkStream } from './stream';
import type { WorkProvider } from './contracts';
import type { WorkResponse } from '../../shared/agent-work';
import type { RuntimeAgentEnv } from '../agent-runtime/env';

async function fixture() {
  const f = taskTestDb();
  f.sqlite.exec('create table team_status_receipts(workspace_id text,site_id text,agent_id text,task_id text,completed_at text); create table team_status_revisions(workspace_id text not null,site_id text not null,revision integer not null default 0,primary key(workspace_id,site_id));');
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const context = { db: f.db as unknown as D1Database, workspaceId: 'w', siteId: 's', task };
  return { ...f, context };
}

it('does not turn Runtime waiting or recovery states into human work requests', async () => {
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  for (const status of ['waiting', 'paused', 'failed'] as const) {
    await stopTask(f.db, task.active_run_id, status, 'Waiting for the parent assignment');
    const current = (await taskForRun(f.db, task.active_run_id))!;
    const context = { db: f.db as unknown as D1Database, workspaceId: 'w', siteId: 's', task: current };
    expect(await runtimeWorkProvider.read!(context)).toEqual([]);
    expect(await pendingWork(context, 'strategy_research', [runtimeWorkProvider])).toEqual([]);
  }
});

function approvalProvider(): WorkProvider {
  return {
    id: 'approval', agents: ['strategy_research'], pending: async () => [],
    read: async () => [{ id: 'approval:item', at: 'today', title: 'Choose an outcome', state: 'attention', interaction: {
      id: 'approval:item', version: 'v1', state: 'pending', fields: [{ id: 'choice', label: 'Choose', kind: 'select', options: [{ value: 'defer', label: 'Handle later' }] }],
      actions: [{ id: 'decide', label: 'Save decision', required_fields: ['choice'] }],
    } }],
    respond: vi.fn(async () => ({ message: 'Saved' })),
  };
}
const approvalInput: WorkResponse = { request_id: 'approval:item', version: 'v1', action: 'decide', values: { choice: 'defer' }, command_id: 'approval-1' };

describe('registered human response contracts', () => {
  it('validates domain-declared fields, action availability, scope and observed version before claiming an operation', async () => {
    const f = await fixture(), provider = approvalProvider(), env = { DB: f.db } as RuntimeAgentEnv;
    for (const patch of [{ version: 'old' }, { action: 'publish' }, { values: {} }, { values: { choice: 'guess' } }, { values: { choice: 'defer', injected: 'x' } }]) {
      await expect(respondToWork(env, f.context, { ...approvalInput, ...patch } as WorkResponse, 'u', [provider])).rejects.toThrow();
    }
    await expect(respondToWork(env, { ...f.context, siteId: 'other' }, approvalInput, 'u', [provider])).rejects.toThrow();
    expect(f.sqlite.prepare('select count(*) as n from agent_work_responses').get()).toEqual({ n: 0 });
    expect(provider.respond).not.toHaveBeenCalled();
  });
  it('replays the receipt and rejects changed inputs, another actor, and a second response to the same version', async () => {
    const f = await fixture(), provider = approvalProvider(), env = { DB: f.db } as RuntimeAgentEnv;
    await respondToWork(env, f.context, approvalInput, 'u', [provider]);
    await respondToWork(env, f.context, { values: { choice: 'defer' }, command_id: 'approval-1', action: 'decide', version: 'v1', request_id: 'approval:item' }, 'u', [provider]);
    await expect(respondToWork(env, f.context, { ...approvalInput, values: {} }, 'u', [provider])).rejects.toThrow('something else');
    await expect(respondToWork(env, f.context, approvalInput, 'other-user', [provider])).rejects.toThrow('something else');
    await expect(respondToWork(env, f.context, { ...approvalInput, command_id: 'approval-2' }, 'u', [provider])).rejects.toThrow('already being processed');
    expect(provider.respond).toHaveBeenCalledOnce();
  });
  it('keeps an interrupted response visible even if the domain request has disappeared', async () => {
    const f = await fixture(), provider = approvalProvider(), env = { DB: f.db } as RuntimeAgentEnv;
    provider.respond = vi.fn(async () => { throw new Error('interrupted'); });
    await expect(respondToWork(env, f.context, approvalInput, 'u', [provider])).rejects.toThrow('interrupted');
    provider.read = async () => [];
    f.sqlite.prepare("update agent_tasks set status='completed' where id=?").run(f.context.task.id);
    expect(await pendingWork(f.context, 'strategy_research', [provider])).toHaveLength(1);
    expect((await workInteractions(f.context, [provider]))[0].interaction?.pending_submission).toEqual(approvalInput);
    provider.respond = async () => ({ message: 'Reconciled' });
    await respondToWork(env, f.context, approvalInput, 'u', [provider]);
    expect(await pendingWork(f.context, 'strategy_research', [provider])).toHaveLength(0);
  });
  it('serializes concurrent retries of one claimed response', async () => {
    const f = await fixture(), provider = approvalProvider(), env = { DB: f.db } as RuntimeAgentEnv;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    provider.respond = vi.fn(async () => { entered(); await gate; return { message: 'Saved' }; });
    const first = respondToWork(env, f.context, approvalInput, 'u', [provider]);
    await entry;
    await expect(respondToWork(env, f.context, approvalInput, 'u', [provider])).rejects.toThrow('being processed');
    release(); await first;
    expect(provider.respond).toHaveBeenCalledOnce();
  });
});

it('paginates all historical work with tied timestamps and never fabricates business summaries', async () => {
  const f = await fixture();
  for (let index = 0; index < 90; index++) f.sqlite.prepare(`insert into agent_task_operations(id,task_id,turn,status,context_json,action_json,created_at,updated_at)
    values(?,?,?,'succeeded','{}',?,'same','same')`).run(`op-${String(index).padStart(3, '0')}`, f.context.task.id, index + 1, JSON.stringify({ name: 'read_topic_state' }));
  const collected = [];
  let cursor = '';
  do {
    const stream = await readWorkStream(f.context, cursor);
    collected.push(...stream.nodes); cursor = stream.next_cursor || '';
  } while (cursor);
  expect(collected).toHaveLength(90);
  expect(new Set(collected.map(node => node.id)).size).toBe(90);
  expect(collected.every(node => node.body === undefined && node.title === 'Review the current topic status')).toBe(true);
});

it('pages notes and operations exactly like one merged query while reading only a page per source', async () => {
  const f = await fixture();
  const id = f.context.task.id;
  f.sqlite.prepare("insert into agent_conversations(task_id,instructions,context_json,created_at) values(?,'','{}','t')").run(id);
  // 120 turns over 40 distinct timestamps (ties); every third turn writes a note that owns its operation.
  for (let turn = 1; turn <= 120; turn++) {
    const at = `2026-01-01T00:${String(Math.floor(turn / 3)).padStart(2, '0')}:00Z`;
    f.sqlite.prepare(`insert into agent_task_operations(id,task_id,turn,status,context_json,action_json,created_at,updated_at) values(?,?,?,'succeeded','{}',?,?,?)`)
      .run(`op-${turn}`, id, turn, JSON.stringify({ name: 'read_topic_state' }), at, at);
    if (turn % 3) continue;
    f.sqlite.prepare("insert into agent_conversation_messages(task_id,sequence,message_key,role,message_json,created_at) values(?,?,?,'assistant','{}',?)").run(id, turn, `m${turn}`, at);
    f.sqlite.prepare('insert into agent_work_notes(task_id,sequence,body,created_at) values(?,?,?,?)').run(id, turn, `note ${turn}`, at);
    f.sqlite.prepare("insert into agent_conversation_calls(task_id,call_id,assistant_sequence,call_index,tool_name,operation_id) values(?,?,?,0,'x',?)").run(id, `c${turn}`, turn, `op-${turn}`);
  }
  // The previous single merged query is the reference order.
  const reference = (before: string[]) => (f.sqlite.prepare(`select id from (
    select 'note:'||n.sequence as id,n.created_at as at from agent_work_notes n where n.task_id=?
    union all
    select o.id,o.created_at from agent_task_operations o where o.task_id=? and o.status!='deciding' and not exists(
      select 1 from agent_conversation_calls c join agent_work_notes n on n.task_id=c.task_id and n.sequence=c.assistant_sequence where c.task_id=o.task_id and c.operation_id=o.id)
    ) where (?='' or at<? or (at=? and id<?)) order by at desc,id desc limit 40`).all(id, id, before[0], before[0], before[0], before[1]) as Array<{ id: string }>).map(row => row.id).reverse();
  let cursor = '';
  let pages = 0;
  do {
    const stream = await readWorkStream(f.context, cursor);
    expect(stream.nodes.map(node => node.id)).toEqual(reference(cursor ? JSON.parse(cursor) : ['', '']));
    cursor = stream.next_cursor || ''; pages++;
  } while (cursor);
  expect(pages).toBe(3);
});

it('discovers durable requests for different Agents with only a registered action handler', async () => {
  for (const agent of ['strategy_research', 'keyword_research']) {
    const f = await fixture();
    f.sqlite.prepare("update agent_tasks set agent_id=?,status='completed' where id=?").run(agent, f.context.task.id);
    f.context.task = { ...f.context.task, agent_id: agent, status: 'completed' };
    const node = (await approvalProvider().read!(f.context))[0];
    await createWorkRequest(f.context, 'approval', node);
    await createWorkRequest(f.context, 'approval', node);
    const provider: WorkProvider = { id: 'approval', respond: vi.fn(async () => ({ message: 'Decision recorded' })) };
    expect(await runtimeTasks(f.context)).toContainEqual(expect.objectContaining({ kind: 'needs_you', reason: 'work_request' }));
    expect(await pendingWork(f.context, agent, [provider])).toMatchObject([{ task_id: f.context.task.id, request_id: node.id }]);
    expect(await workInteractions(f.context, [provider])).toMatchObject([{ title: 'Choose an outcome' }]);
    await expect(createWorkRequest(f.context, 'approval', { ...node, body: 'different' })).rejects.toThrow('identity');
    await expect(createWorkRequest({ ...f.context, siteId: 'elsewhere' }, 'approval', node)).rejects.toThrow();
    expect(await pendingWork({ ...f.context, siteId: 'elsewhere' }, agent, [provider])).toEqual([]);
    await respondToWork({ DB: f.db } as RuntimeAgentEnv, f.context, approvalInput, 'u', [provider]);
    await respondToWork({ DB: f.db } as RuntimeAgentEnv, f.context, approvalInput, 'u', [provider]);
    expect(provider.respond).toHaveBeenCalledTimes(1);
    expect(await pendingWork(f.context, agent, [provider])).toEqual([]);
    expect((await runtimeTasks(f.context)).some(item => item.kind === 'needs_you')).toBe(false);
    expect((await workInteractions(f.context, [provider])).some(item => item.body?.includes('Choose: defer'))).toBe(true);
    expect((await workInteractions(f.context, [provider]))[0].interaction?.state).toBe('resolved');
  }
});

it('preserves a durable pending submission on failure and blocks cancelled tasks', async () => {
  const f = await fixture();
  const node = (await approvalProvider().read!(f.context))[0];
  await createWorkRequest(f.context, 'approval', node);
  const provider: WorkProvider = { id: 'approval', respond: vi.fn(async () => { throw new Error('uncertain effect'); }) };
  await expect(respondToWork({ DB: f.db } as RuntimeAgentEnv, f.context, approvalInput, 'u', [provider])).rejects.toThrow('uncertain');
  expect((await workInteractions(f.context, [provider]))[0].interaction?.pending_submission).toMatchObject(approvalInput);
  f.sqlite.prepare("update agent_tasks set status='cancelled' where id=?").run(f.context.task.id);
  f.context.task = { ...f.context.task, status: 'cancelled' };
  expect((await workInteractions(f.context, [provider]))[0].interaction?.state).toBe('resolved');
  expect(await respondToWork({ DB: f.db } as RuntimeAgentEnv, f.context, approvalInput, 'u', [provider])).toMatchObject({ outcome: 'superseded' });
  expect(provider.respond).toHaveBeenCalledTimes(1);
});
