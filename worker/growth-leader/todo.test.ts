import { describe, expect, it } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { agentDefinition } from '../agent-runtime/definitions';
import { attachTask, beginTaskDecision, finishTaskOperation, requireTask } from '../agent-runtime/task-store';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution } from '../agent-runtime/runtime-executions';
import { executionEnvironment } from '../agent-runtime/execution-context';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { leaderTodoTools, readLeaderTodo } from './todo';

async function fixture() {
  const f = taskTestDb();
  const run = { ...f.run('leader'), agent_id: 'growth_leader', definition_version: 5 };
  f.sqlite.prepare("update agent_runs set agent_id='growth_leader',definition_version=5 where id=?").run(run.id);
  await attachTask(f.db, run, agentDefinition('growth_leader'));
  const execution = await createRuntimeExecution(f.db, run.id);
  await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  const env = executionEnvironment({ DB: f.db } as RuntimeAgentEnv, authorityForExecution(execution));
  const current = () => requireTask(env.DB, run.id);
  const write = async (ref: string, markdown: string) => {
    const task = await current();
    const operation = await beginTaskDecision(env.DB, task, {});
    const tool = leaderTodoTools(env, task, operation).resolve(agentDefinition('growth_leader'), 'write_todo');
    const args = { observation_ref: ref, markdown };
    const context = { runId: run.id, workspaceId: 'w', siteId: 's', idempotencyKey: operation.id };
    const result = await tool.execute!(args, context);
    await finishTaskOperation(env.DB, task, operation, result);
    return { result, replay: () => tool.execute!(args, context) };
  };
  return { ...f, env, current, write };
}

describe('Leader conversation todo file', () => {
  it('preserves unrelated workspace data, history and later edits when replaying an old write', async () => {
    const f = await fixture();
    f.sqlite.exec(`update agent_tasks set workspace_json='{"unrelated":{"value":7}}' where id='leader'`);
    const empty = await readLeaderTodo(f.env, await f.current());
    expect(empty).toMatchObject({ path: 'todo.md', exists: false, markdown: '' });
    const first = await f.write(empty.observation_ref, '# Goal\n- [ ] New work');
    const observed = await readLeaderTodo(f.env, await f.current());
    await f.write(observed.observation_ref, '# Goal\n- [x] Evidence checked\n- [ ] New work');
    await first.replay();
    expect((await readLeaderTodo(f.env, await f.current())).markdown).toContain('Evidence checked');
    const workspace = JSON.parse((await f.current()).workspace_json);
    expect(workspace.unrelated).toEqual({ value: 7 });
    expect(workspace.leader_todo.previous_observation_ref).toBe(observed.observation_ref);
    const archived = f.sqlite.prepare('select value_json from agent_parameter_slots where task_id=? and ref=?').get('leader', observed.observation_ref) as { value_json: string };
    expect(JSON.parse(archived.value_json).workspace.leader_todo.markdown).toBe('# Goal\n- [ ] New work');
  });

  it('rejects stale observations without losing the current file', async () => {
    const f = await fixture();
    const empty = await readLeaderTodo(f.env, await f.current());
    await f.write(empty.observation_ref, 'Current work');
    await expect(f.write(empty.observation_ref, 'Overwrite')).rejects.toThrow('Workspace changed');
    expect((await readLeaderTodo(f.env, await f.current())).markdown).toBe('Current work');
  });

  it('does not resolve another conversation’s edit reference', async () => {
    const f = await fixture();
    const other = f.run('other');
    await attachTask(f.db, other, agentDefinition('strategy_research'));
    f.sqlite.prepare('insert into agent_parameter_slots(task_id,ref,kind,value_json) values(?,?,?,?)').run('other', 'foreign', 'leader_todo', '{"revision":0,"workspace":{}}');
    await expect(f.write('foreign', 'Overwrite')).rejects.toThrow('out-of-scope');
    expect((await readLeaderTodo(f.env, await f.current())).exists).toBe(false);
  });

  it('rejects cancelled execution writes', async () => {
    const f = await fixture();
    const empty = await readLeaderTodo(f.env, await f.current());
    f.sqlite.exec("update agent_tasks set status='cancelled' where id='leader'");
    await expect(f.write(empty.observation_ref, 'Cancelled')).rejects.toThrow();
  });
});
