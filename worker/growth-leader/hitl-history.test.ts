import { expect, it } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { agentDefinition } from '../agent-runtime/definitions';
import { attachTask } from '../agent-runtime/task-store';
import { createWorkRequest } from '../agent-work';
import { hitlWorkNode } from '../agent-work/hitl-node';
import { readLeaderHitlHistory } from './hitl-history';

it('keeps a resolved Leader HITL request with its original spec and submitted choice', async () => {
  const f = taskTestDb();
  const run = f.run('leader', 'leader');
  f.sqlite.prepare("update agent_runs set agent_id='growth_leader' where id=?").run(run.id);
  const task = await attachTask(f.db, { ...run, agent_id: 'growth_leader' }, agentDefinition('growth_leader'));
  const spec = { schema_version: 1, title: 'Confirm next batch of topic proposals', blocks: [
    { type: 'text', text: 'Choose from the available topics.' },
    { type: 'choice', id: 'topic', label: 'Topic', options: [{ value: 'first', label: 'First piece' }, { value: 'second', label: 'Second piece' }] },
  ], actions: [{ id: 'confirm', label: 'Continue in recommended order' }] };
  const node = hitlWorkNode('hitl:leader:1', '2026-09-25T05:43:00Z', spec);
  await createWorkRequest({ db: f.db, workspaceId: 'w', siteId: 's', task }, 'hitl', node);
  expect((await readLeaderHitlHistory(f.db, task))[0]).toMatchObject({ interaction: { state: 'pending', spec } });

  f.sqlite.prepare("update agent_work_requests set state='resolved' where task_id=? and request_id=?").run(task.id, node.id);
  f.sqlite.prepare(`insert into agent_work_responses(command_id,task_id,request_id,version,actor_id,input_json,node_json,receipt_json,created_at)
    values(?,?,?,?,?,?,?,?,?)`).run('answer-1', task.id, node.id, '1', 'user',
    JSON.stringify({ request_id: node.id, version: '1', action: 'confirm', values: { topic: 'first' } }),
    JSON.stringify(node), JSON.stringify({ message: 'Response saved; the Agent will continue in the original task.' }), '2026-09-25T05:45:00Z');
  const history = await readLeaderHitlHistory(f.db, task);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ title: spec.title, interaction: { state: 'resolved', spec, response: {
    action: 'confirm', label: 'Continue in recommended order', values: { topic: 'first' }, at: '2026-09-25T05:45:00Z',
  } } });
});
