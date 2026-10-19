import { describe, expect, it, vi } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import { taskForRun, readTaskOperation } from '../agent-runtime/task-store';
import { agentDefinition } from '../agent-runtime/definitions';
import { leaderTools } from './tools';
import { readLeaderTopics } from './evidence-context';
import { topicWorkProvider } from '../agent-work/topic-provider';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from '../agent-runtime/env';

async function fixture() {
  const f = schemaTestDb();
  f.sqlite.exec('pragma foreign_keys=off');
  f.insert('workspaces', { id: 'w', name: 'Workspace' });
  f.insert('sites', { id: 's', workspace_id: 'w', name: 'Site', source_locale: 'en', translate_locales_json: '[]' });
  f.insert('agent_runs', { id: 'leader', workspace_id: 'w', site_id: 's', agent_id: 'growth_leader',
    agent_instance_id: 'leader', definition_version: 12, prompt_version: 'growth-leader-v12-topic-review',
    trigger: 'manual', status: 'running', phase: 'conversation', root_run_id: 'leader', summary_json: '{}' });
  f.insert('agent_tasks', { id: 'leader-task', active_run_id: 'leader', root_task_id: 'leader-task',
    workspace_id: 'w', site_id: 's', agent_id: 'growth_leader', agent_instance_id: 'leader',
    definition_version: 12, status: 'running', next_turn: 1 });
  f.insert('agent_task_runs', { run_id: 'leader', task_id: 'leader-task', epoch: 1 });
  f.insert('agent_task_operations', { id: 'topic-op', task_id: 'leader-task', turn: 1, status: 'running',
    context_json: '{}', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  f.insert('agent_runs', { id: 'child', workspace_id: 'w', site_id: 's', agent_id: 'topic_decision',
    agent_instance_id: 'topic:en', definition_version: 24, prompt_version: 'topic-decision-library-v19-language',
    trigger: 'sub_agent', status: 'succeeded', phase: 'done', root_run_id: 'leader', parent_run_id: 'leader', summary_json: '{}' });
  f.insert('agent_tasks', { id: 'child-task', active_run_id: 'child', root_task_id: 'leader-task', parent_task_id: 'leader-task',
    workspace_id: 'w', site_id: 's', agent_id: 'topic_decision', agent_instance_id: 'topic:en',
    definition_version: 24, status: 'completed' });
  f.insert('agent_task_runs', { run_id: 'child', task_id: 'child-task', epoch: 1 });
  f.insert('topic_decision_results', { id: 'group', workspace_id: 'w', site_id: 's', run_id: 'child',
    submission_operation_id: 'child-submit', decision_type: 'topic_group', status: 'draft', scope_locale: 'en',
    group_goal: 'Two useful English topics', rationale: 'Search demand', updated_at: '2026-09-25T00:00:00Z' });
  f.insert('topic_decision_items', { id: 'item', result_id: 'group', title_direction: 'Write better emails',
    primary_keyword: 'email writing', locale: 'en', rationale: 'Useful to readers', sort_order: 0 });
  const task = (await taskForRun(f.db, 'leader'))!;
  const operation = (await readTaskOperation(f.db, task.id, 1))!;
  const create = vi.fn(async (options: { id: string }) => ({ id: options.id }));
  const env = { DB: f.db, AGENT_WORKFLOW: { create }, AGENT_RUNTIME_ENABLED: 'true' } as unknown as RuntimeAgentEnv;
  const registry = leaderTools(env, {} as RuntimeWorkflowStep, task, operation);
  const tool = registry.resolve(agentDefinition('growth_leader'), 'review_topic_group');
  return { ...f, task, tool, create, context: { runId: 'leader', workspaceId: 'w', siteId: 's', idempotencyKey: 'topic-op' } };
}

const observed = '2026-09-25T00:00:00Z';

describe('Leader topic review', () => {
  it('keeps the new action out of older pinned Leader tool lists', async () => {
    const f = await fixture();
    f.sqlite.prepare("update agent_tasks set definition_version=10 where id='leader-task'").run();
    const old = (await taskForRun(f.db, 'leader'))!;
    const registry = leaderTools({ DB: f.db } as RuntimeAgentEnv, {} as RuntimeWorkflowStep, old);
    expect(registry.names()).not.toContain('review_topic_group');
  });

  it('shows Leader review as work in progress rather than a human confirmation', async () => {
    const f = await fixture();
    const scope = { db: f.db, workspaceId: 'w', siteId: 's' };
    expect(await topicWorkProvider.pending!(scope, 'topic_decision')).toEqual([]);
    const child = (await taskForRun(f.db, 'child'))!;
    expect(await topicWorkProvider.read!({ ...scope, task: child })).toMatchObject([
      { title: 'Leader is reviewing the topic plan', state: 'working', interaction: undefined },
    ]);
    f.sqlite.prepare("update agent_tasks set definition_version=10 where id='leader-task'").run();
    expect(await topicWorkProvider.pending!(scope, 'topic_decision')).toHaveLength(1);
  });

  it('exposes the specific proposal and its version before a decision', async () => {
    const f = await fixture();
    const view = await readLeaderTopics({ DB: f.db } as RuntimeAgentEnv, f.task, 'group', 0);
    expect(view.group).toMatchObject({ target_ref: 'group', updated_at: observed, rationale: 'Search demand' });
    expect(view.items).toMatchObject([{ topic_ref: 'item', title_direction: 'Write better emails', rationale: 'Useful to readers' }]);
  });

  it('approves its own observed group once and creates article jobs', async () => {
    const f = await fixture();
    const input = { group_ref: 'group', observed_updated_at: observed, decision: 'approve' as const, reason: 'Fits the current goal' };
    const outcome = await f.tool.execute!(input, f.context) as { content_task_ref: string };
    expect(outcome.content_task_ref).toBeTruthy();
    expect(f.sqlite.prepare("select status,reviewed_by,review_operation_id from topic_decision_results where id='group'").get())
      .toEqual({ status: 'handed_off', reviewed_by: 'growth_leader', review_operation_id: 'topic-op' });
    expect(f.sqlite.prepare("select count(*) n from jobs where decision_group_id='group'").get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare("select count(*) n from agent_tasks where parent_task_id='leader-task' and agent_id='content_production'").get())
      .toEqual({ n: 1 });
    await f.tool.execute!(input, f.context);
    expect(f.sqlite.prepare("select count(*) n from jobs where decision_group_id='group'").get()).toEqual({ n: 1 });
  });

  it('rejects stale or unrelated groups without creating work', async () => {
    const f = await fixture();
    const input = { group_ref: 'group', observed_updated_at: 'older', decision: 'approve' as const, reason: 'Looks good' };
    await expect(f.tool.execute!(input, f.context)).rejects.toThrow('changed after observation');
    f.sqlite.prepare("update agent_tasks set parent_task_id='someone-else' where id='child-task'").run();
    await expect(f.tool.execute!({ ...input, observed_updated_at: observed }, f.context)).rejects.toThrow('not delegated');
    expect(f.sqlite.prepare("select count(*) n from jobs where decision_group_id='group'").get()).toEqual({ n: 0 });
  });

  it('records revision feedback and assigns a new topic task instead of silently finishing', async () => {
    const f = await fixture();
    const input = { group_ref: 'group', observed_updated_at: observed, decision: 'revise' as const,
      reason: 'Explain how this differs from the existing email guide.' };
    const result = await f.tool.execute!(input, f.context) as { revision_task_ref: string };
    expect(f.sqlite.prepare("select status,review_note from topic_decision_results where id='group'").get())
      .toEqual({ status: 'rejected', review_note: input.reason });
    expect(result.revision_task_ref).toBeTruthy();
    expect(f.sqlite.prepare("select count(*) n from agent_tasks where parent_task_id='leader-task' and agent_id='topic_decision'").get())
      .toEqual({ n: 2 });
    await f.tool.execute!(input, f.context);
    expect(f.sqlite.prepare("select count(*) n from agent_tasks where parent_task_id='leader-task' and agent_id='topic_decision'").get())
      .toEqual({ n: 2 });
  });
});
