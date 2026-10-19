import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import type { RuntimeAgentEnv } from './env';
import { contentGroupInstance } from './content-production';
import { continueContentRevision } from './content-revision-dispatch';
import { startRuntimeRun } from './run-service';

vi.mock('./run-service', () => ({ startRuntimeRun: vi.fn(async () => ({ id: 'dispatched' })) }));

const input = { workspaceId: 'w', siteId: 's', groupId: 'group', decisionGroupId: 'decision', jobId: 'job' };
function fixture(status: string, siteId = 's') {
  const f = schemaTestDb();
  f.sqlite.exec('pragma foreign_keys=off');
  f.insert('agent_runs', { id: 'parent', workspace_id: 'w', site_id: siteId, agent_id: 'content_production',
    agent_instance_id: contentGroupInstance('group'), status: 'running', definition_version: 25 });
  f.insert('agent_tasks', { id: 'task', active_run_id: 'parent', workspace_id: 'w', site_id: siteId,
    agent_id: 'content_production', status });
  f.insert('agent_task_runs', { run_id: 'parent', task_id: 'task', epoch: 1 });
  return { ...f, env: { DB: f.db } as RuntimeAgentEnv };
}

describe('human content revision dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the running group manager instead of creating a conflicting Run', async () => {
    const f = fixture('running');
    expect((await continueContentRevision(f.env, input)).id).toBe('parent');
    expect(startRuntimeRun).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('select count(*) n from agent_runs').get()).toEqual({ n: 1 });
  });

  it('resumes a waiting manager through the normal guarded recovery service', async () => {
    const f = fixture('waiting');
    await continueContentRevision(f.env, input);
    expect(startRuntimeRun).toHaveBeenCalledWith(f.env, expect.objectContaining({ trigger: 'retry', retryOfRunId: 'parent' }));
  });

  it('does not reuse another site or production group', async () => {
    const f = fixture('running', 'other-site');
    await continueContentRevision(f.env, input);
    expect(startRuntimeRun).toHaveBeenCalledWith(f.env, expect.objectContaining({
      siteId: 's', trigger: 'manual', instanceId: contentGroupInstance('group'),
      summary: { group_id: 'group', decision_group_id: 'decision', human_revision_job_id: 'job' },
    }));
    vi.clearAllMocks();
    await continueContentRevision(f.env, { ...input, siteId: 'other-site', groupId: 'another-group' });
    expect(startRuntimeRun).toHaveBeenCalledWith(f.env, expect.objectContaining({
      trigger: 'manual', instanceId: contentGroupInstance('another-group'),
    }));
  });
});
