import { describe, expect, it, vi } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import { runConversationTask } from '../agent-runtime/conversation-runtime';
import { runBusinessConversationTask } from './business';
import {
  createPractice,
  recordPreparationFailure,
  type LearningRequest,
} from './store';

vi.mock('../agent-runtime/conversation-runtime', () => ({
  runConversationTask: vi.fn(async () => ({ outcome: 'business_completed' })),
}));

describe('business learning preparation gate', () => {
  it('passes a new specialist through unchanged without preparing or injecting learning context', async () => {
    const f = schemaTestDb();
    f.insert('sites', { id: 'site', workspace_id: 'primary-workspace' });
    f.insert('agent_runs', { id: 'new-topic', workspace_id: 'primary-workspace', site_id: 'site', agent_id: 'topic_decision', status: 'running', root_run_id: 'new-topic' });
    f.insert('agent_tasks', { id: 'new-topic', active_run_id: 'new-topic', workspace_id: 'primary-workspace', site_id: 'site', agent_id: 'topic_decision', status: 'running', root_task_id: 'new-topic', definition_version: 28 });
    f.insert('agent_task_runs', { run_id: 'new-topic', task_id: 'new-topic', epoch: 0 });
    const input = { env: { DB: f.db }, runId: 'new-topic', step: { sleep: vi.fn() },
      agent: { instructions: 'Original mission', context: async () => ({ original: true }) } } as unknown as Parameters<typeof runBusinessConversationTask>[0];
    await runBusinessConversationTask(input);
    expect(vi.mocked(runConversationTask).mock.calls.at(-1)![0]).toBe(input);
    expect(f.sqlite.prepare('select count(*) n from learning_records').get()).toEqual({ n: 0 });
    expect(input.step.sleep).not.toHaveBeenCalled();
  });
  it('continues the original business task after three persisted availability failures', async () => {
    const f = schemaTestDb();
    const scope = { workspaceId: 'primary-workspace', siteId: 'site' };
    f.insert('sites', { id: 'site', workspace_id: scope.workspaceId });
    f.insert('agent_runs', {
      id: 'topic',
      workspace_id: scope.workspaceId,
      site_id: 'site',
      agent_id: 'topic_decision',
      agent_instance_id: 'topic',
      status: 'running',
      root_run_id: 'topic',
    });
    f.insert('agent_tasks', {
      id: 'topic',
      active_run_id: 'topic',
      workspace_id: scope.workspaceId,
      site_id: 'site',
      agent_id: 'topic_decision',
      agent_instance_id: 'topic',
      status: 'running',
      root_task_id: 'topic',
      definition_version: 27,
    });
    f.insert('agent_task_runs', {
      run_id: 'topic',
      task_id: 'topic',
      epoch: 0,
    });
    const record = await createPractice(
      f.db,
      scope,
      'topic',
      'topic_decision',
      'Test a business claim',
    );
    let failures = 0;
    const sleep = vi.fn(async () => {
      const request = await f.db
        .prepare('select * from learning_requests where record_id=?')
        .bind(record.id)
        .first<LearningRequest>();
      await recordPreparationFailure(
        f.db,
        scope,
        request!,
        `availability:${++failures}`,
        'Synthetic temporary failure',
      );
    });
    const input = {
      env: { DB: f.db },
      step: { sleep },
      runId: 'topic',
      definition: { tools: [] },
      agent: {
        instructions: 'Original business mission',
        context: async () => ({ original: true }),
        tools: vi.fn(),
      },
    } as unknown as Parameters<typeof runBusinessConversationTask>[0];
    expect(await runBusinessConversationTask(input)).toEqual({
      outcome: 'business_completed',
    });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(
      f.sqlite
        .prepare('select failure_count,status from learning_requests')
        .get(),
    ).toEqual({ failure_count: 3, status: 'skipped' });
    const resumed = vi.mocked(runConversationTask).mock.calls.at(-1)![0];
    expect(resumed.runId).toBe('topic');
    const task = await f.db
      .prepare('select * from agent_tasks where id=?')
      .bind('topic')
      .first();
    const context = (await resumed.agent.context(task as never)) as {
      original: boolean;
      learning: {
        formed: { experience: { preparation: string; evaluation: unknown } };
      };
    };
    expect(context.original).toBe(true);
    expect(context.learning.formed.experience).toMatchObject({
      preparation: 'skipped',
      evaluation: null,
    });
    await runBusinessConversationTask(input);
    expect(sleep).toHaveBeenCalledTimes(3);
    const next = await createPractice(
      f.db,
      scope,
      'next-topic',
      'topic_decision',
      'Next independent practice',
    );
    expect(JSON.parse(next.data_json).experience.preparation).toBe('pending');
  });
});
