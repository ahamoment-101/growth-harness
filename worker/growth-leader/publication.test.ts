import { describe, expect, it, vi } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import { taskForRun, readTaskOperation } from '../agent-runtime/task-store';
import { agentDefinition } from '../agent-runtime/definitions';
import { leaderTools } from './tools';
import { startPublish } from '../lib/dispatch';
import { workflowInstanceId } from '../lib/workflow-instance-id';
import { saveSlot } from '../agent-runtime/parameter-slots';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from '../agent-runtime/env';

const versions = JSON.stringify([{ locale: 'en', slug: 'guide', title: 'Guide', excerpt: 'Guide', content: 'Useful guide.' }]);

async function fixture(leaderVersion = 3) {
  const f = schemaTestDb();
  f.sqlite.exec('pragma foreign_keys=off');
  f.insert('workspaces', { id: 'w', name: 'Workspace' });
  f.insert('sites', { id: 's', workspace_id: 'w', name: 'Site', ingest_url: 'https://example.invalid',
    source_locale: 'en', translate_locales_json: '[]', domain: 'blog.example.com', domain_status: 'live',
    hub_path: '/', product_origin: 'https://example.com' });
  f.insert('content_production_groups', { id: 'g', workspace_id: 'w', site_id: 's', decision_group_id: 'dg',
    parent_run_id: 'old-content-run', status: 'awaiting_review', total_items: 1, ready_items: 1 });
  f.insert('jobs', { id: 'j', site_id: 's', status: 'drafting', production_group_id: 'g', current_artifact_id: 'a1',
    decision_group_id: 'dg', child_run_id: 'author', versions_json: versions, en_title: 'Guide' });
  f.insert('content_artifacts', { id: 'a1', group_id: 'g', job_id: 'j', decision_item_id: 'di', child_run_id: 'author',
    submission_operation_id: 'submit-a1', attempt: 1, status: 'accepted', versions_json: versions,
    qa_report_json: '{"ok":true,"issues":[]}', parent_review_json: '{"decision":"pass","value_assessment":"Useful"}' });
  f.sqlite.prepare("update jobs set status='awaiting_review' where id='j'").run();
  f.insert('agent_runs', { id: 'publication:s', workspace_id: 'w', site_id: 's', agent_id: 'growth_leader',
    agent_instance_id: 'publication:s', definition_version: leaderVersion, prompt_version: 'growth-leader-v3-event-pool',
    trigger: 'manual', status: 'running', phase: 'conversation', root_run_id: 'publication:s', summary_json: '{}' });
  f.insert('agent_tasks', { id: 'leader-task', active_run_id: 'publication:s', root_task_id: 'leader-task',
    workspace_id: 'w', site_id: 's', agent_id: 'growth_leader', agent_instance_id: 'publication:s',
    definition_version: leaderVersion, status: 'running', next_turn: 1 });
  f.insert('agent_task_runs', { run_id: 'publication:s', task_id: 'leader-task', epoch: 1 });
  f.insert('agent_task_operations', { id: 'op1', task_id: 'leader-task', turn: 1, status: 'running',
    context_json: '{}', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const task = (await taskForRun(f.db, 'publication:s'))!;
  const operation = (await readTaskOperation(f.db, task.id, 1))!;
  const create = vi.fn(async () => ({ id: 'publish-workflow' }));
  const env = { DB: f.db, PUBLISH_WORKFLOW: { create }, AGENT_WORKFLOW: { create: vi.fn(async (options:{id:string}) => ({id:options.id})) },
    AGENT_RUNTIME_ENABLED: 'true' } as unknown as RuntimeAgentEnv;
  const registry = leaderTools(env, {} as RuntimeWorkflowStep, task, operation);
  const tool = registry.resolve(agentDefinition('growth_leader'), 'decide_publication');
  const completeTool = registry.resolve(agentDefinition('growth_leader'), 'complete_inbox_event');
  const context = { runId: 'publication:s', workspaceId: 'w', siteId: 's', idempotencyKey: 'op1' };
  return { ...f, tool, completeTool, context, create, env, task };
}

describe('Leader publication decision', () => {
  it('publishes the exact accepted version and records the decision once', async () => {
    const f = await fixture();
    const input = { event_ref: 'article-review:j:a1', decision: 'publish' as const, reason: 'Reviewer evidence is sufficient', required_changes: [] };
    await f.tool.execute!(input, f.context);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare("select status,workflow_id,publication_operation_id from jobs where id='j'").get())
      .toEqual({ status: 'publishing', workflow_id: workflowInstanceId('publish', 'op1'), publication_operation_id: 'op1' });
    expect(f.sqlite.prepare("select status,decision,operation_id from agent_event_deliveries where event_id='article-review:j:a1'").get())
      .toEqual({ status: 'completed', decision: 'publish', operation_id: 'op1' });
    await f.tool.execute!(input, f.context);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('retains the workflow identity after an uncertain dispatch and resumes the same decision', async () => {
    const f = await fixture();
    const input = { event_ref: 'article-review:j:a1', decision: 'publish' as const, reason: 'Ready', required_changes: [] };
    f.create.mockRejectedValueOnce(new Error('dispatch unavailable'));
    await expect(f.tool.execute!(input, f.context)).rejects.toThrow('dispatch unavailable');
    expect(f.sqlite.prepare("select status,workflow_id,publication_operation_id from jobs where id='j'").get())
      .toEqual({ status: 'publishing', workflow_id: workflowInstanceId('publish', 'op1'), publication_operation_id: 'op1' });
    await f.tool.execute!(input, f.context);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create).toHaveBeenLastCalledWith({ id: workflowInstanceId('publish', 'op1'), params: { jobId: 'j' } });
    expect(f.sqlite.prepare("select status from agent_event_deliveries where event_id='article-review:j:a1'").get())
      .toEqual({ status: 'completed' });
  });

  it('rejects a changed article without starting publication', async () => {
    const f = await fixture();
    f.sqlite.prepare('update jobs set versions_json=? where id=?').run(versions.replace('Useful guide.', 'Changed guide.'), 'j');
    await expect(f.tool.execute!({ event_ref: 'article-review:j:a1', decision: 'publish', reason: 'Ready', required_changes: [] }, f.context))
      .rejects.toThrow('Accepted article changed');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.sqlite.prepare("select status,operation_id from agent_event_deliveries where event_id='article-review:j:a1'").get())
      .toEqual({ status: 'pending', operation_id: '' });
  });

  it('accepts only one publication when a human acts before or after Leader', async () => {
    const humanFirst = await fixture();
    await startPublish(humanFirst.env as Env, 'j');
    expect(await humanFirst.tool.execute!({ event_ref: 'article-review:j:a1', decision: 'publish', reason: 'Ready', required_changes: [] }, humanFirst.context))
      .toMatchObject({ superseded: true });
    expect(humanFirst.create).toHaveBeenCalledTimes(1);

    const leaderFirst = await fixture();
    await leaderFirst.tool.execute!({ event_ref: 'article-review:j:a1', decision: 'publish', reason: 'Ready', required_changes: [] }, leaderFirst.context);
    await expect(startPublish(leaderFirst.env as Env, 'j')).rejects.toThrow('no longer awaiting_review');
    expect(leaderFirst.create).toHaveBeenCalledTimes(1);
  });

  it('closes a claimed Leader event if a human wins the publication transition', async () => {
    const f = await fixture();
    f.sqlite.prepare("update agent_event_deliveries set operation_id='op1',decision='publish' where event_id='article-review:j:a1'").run();
    await startPublish(f.env as Env, 'j');
    expect(f.sqlite.prepare("select status from agent_event_deliveries where event_id='article-review:j:a1'").get())
      .toEqual({ status: 'superseded' });
    expect(await f.tool.execute!({ event_ref: 'article-review:j:a1', decision: 'publish', reason: 'Ready', required_changes: [] }, f.context))
      .toMatchObject({ superseded: true });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('uses the observed site language policy slot when Leader approves publication', async () => {
    const f = await fixture(13);
    f.sqlite.prepare("update sites set translate_locales_json='[\"pt-BR\"]' where id='s'").run();
    const ref = await saveSlot(f.db, f.task, 'leader_publication_policy', { mode: 'all_enabled', enabled_locales: ['en', 'pt-BR'] });
    await f.tool.execute!({ event_ref: 'article-review:j:a1', decision: 'publish', reason: 'Ready', required_changes: [], publication_policy_ref: ref }, f.context);
    expect(f.create).toHaveBeenCalledWith({ id: workflowInstanceId('publish', 'op1'), params: { jobId: 'j', localizationLocales: ['pt-BR'] } });
  });

  it('exposes the policy through the inbox and rejects a stale policy before claiming an effect', async () => {
    const f = await fixture(13);
    f.sqlite.prepare("update sites set translate_locales_json='[\"pt-BR\"]' where id='s'").run();
    const inbox = leaderTools(f.env, {} as RuntimeWorkflowStep, f.task, (await readTaskOperation(f.db, f.task.id, 1))!)
      .resolve(agentDefinition('growth_leader'), 'read_my_inbox');
    const read = await inbox.execute!({}, f.context) as { events: Array<{ publication_policy_ref:string; publication_policy:{mode:string} }> };
    expect(read.events[0].publication_policy).toMatchObject({ mode: 'all_enabled' });
    const ref = read.events[0].publication_policy_ref;
    f.sqlite.prepare("update sites set publication_language_mode='source_only' where id='s'").run();
    await expect(f.tool.execute!({ event_ref: 'article-review:j:a1', decision: 'publish', reason: 'Ready', required_changes: [], publication_policy_ref: ref }, f.context))
      .rejects.toThrow('Publication language policy changed');
    expect(f.sqlite.prepare("select operation_id from agent_event_deliveries where event_id='article-review:j:a1'").get()).toEqual({ operation_id: '' });
  });

  it('returns one article to the content team with a durable revision assignment', async () => {
    const f = await fixture();
    const input = { event_ref: 'article-review:j:a1', decision: 'revise' as const, reason: 'Needs a clearer source',
      required_changes: ['Verify the product claim against the official page'] };
    const result = await f.tool.execute!(input, f.context) as { result_ref: string };
    expect(result.result_ref).toMatch(/^task:/);
    expect(f.sqlite.prepare("select status,review_note from jobs where id='j'").get())
      .toEqual({ status: 'drafting', review_note: input.required_changes[0] });
    expect(f.sqlite.prepare("select status from content_artifacts where id='a1'").get()).toEqual({ status: 'rejected' });
    expect(f.sqlite.prepare("select status,decision from agent_event_deliveries where event_id='article-review:j:a1'").get())
      .toEqual({ status: 'completed', decision: 'revise' });
    expect(f.sqlite.prepare("select count(*) n from agent_tasks where parent_task_id='leader-task' and agent_id='content_production'").get())
      .toEqual({ n: 1 });
  });

  it('explicitly completes a task report without allowing that tool to complete an article review', async () => {
    const f = await fixture();
    f.insert('agent_pool_events', { id: 'task-report:child:done', workspace_id: 'w', site_id: 's',
      type: 'agent.task_report_ready', schema_version: 1, subject_id: 'child', subject_version: 'done',
      source_ref: 'publication:s', summary: 'Research completed', available_at: new Date().toISOString() });
    f.insert('agent_event_deliveries', { event_id: 'task-report:child:done', agent_id: 'growth_leader',
      workspace_id: 'w', site_id: 's', target_run_id: 'publication:s', available_at: new Date().toISOString() });
    const input = { event_ref: 'task-report:child:done', reason: 'Read the result and noted the next action' };
    await f.completeTool.execute!(input, f.context);
    expect(await f.completeTool.execute!(input, f.context)).toMatchObject({ replay: true });
    expect(f.sqlite.prepare("select status from agent_event_deliveries where event_id='task-report:child:done'").get())
      .toEqual({ status: 'completed' });
    await expect(f.completeTool.execute!({ event_ref: 'article-review:j:a1', reason: 'skip' }, f.context))
      .rejects.toThrow('not actionable');
    f.insert('agent_pool_events', { id: 'article-published:j:a1', workspace_id: 'w', site_id: 's',
      type: 'content.article_published', schema_version: 1, subject_id: 'j', subject_version: 'a1',
      available_at: new Date().toISOString() });
    f.insert('agent_event_deliveries', { event_id: 'article-published:j:a1', agent_id: 'growth_leader',
      workspace_id: 'w', site_id: 's', target_run_id: 'publication:s', available_at: new Date().toISOString() });
    expect(await f.completeTool.execute!({ event_ref: 'article-published:j:a1', reason: 'Confirmed live article' }, f.context))
      .toMatchObject({ completed: true });
  });
});
