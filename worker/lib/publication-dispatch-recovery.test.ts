import { describe, expect, it, vi } from 'vitest';
import { schemaTestDb } from './schema-test-db';
import { reconcilePublicationDispatches } from './publication-dispatch-recovery';
import { workflowInstanceId } from './workflow-instance-id';

const operationId = '20704b3d-3387-44bd-8830-df3982069671:16';
const versions = JSON.stringify([{ locale: 'en', slug: 'guide', title: 'Guide', content: 'Content' }]);

function fixture(workflowId = `publish:${operationId}`) {
  const f = schemaTestDb();
  f.sqlite.exec('pragma foreign_keys=off');
  f.insert('workspaces', { id: 'w', name: 'Workspace' });
  f.insert('sites', { id: 's', workspace_id: 'w', name: 'Site', source_locale: 'en', translate_locales_json: '["pt-BR"]' });
  f.insert('jobs', { id: 'j', site_id: 's', status: 'publishing', workflow_id: workflowId,
    publication_operation_id: operationId, versions_json: versions, updated_at: '2026-09-25T14:00:00.000Z' });
  f.insert('agent_task_operations', { id: operationId, task_id: 'leader', turn: 16, status: 'failed',
    context_json: '{}', action_json: '{"input":{"publication_policy_ref":"policy"}}' });
  f.insert('agent_parameter_slots', { task_id: 'leader', ref: 'policy', kind: 'leader_publication_policy',
    value_json: '{"mode":"all_enabled","enabled_locales":["en","pt-BR"]}' });
  const get = vi.fn(async () => { throw new Error('(instance.not_found) Instance not found'); });
  const createBatch = vi.fn(async () => []);
  const env = { DB: f.db, PUBLISH_WORKFLOW: { get, createBatch } } as unknown as Env;
  return { ...f, env, get, createBatch };
}

describe('publication dispatch recovery', () => {
  it('repairs a legacy invalid ID and dispatches the original language policy once', async () => {
    const f = fixture();
    expect(await reconcilePublicationDispatches(f.env, new Date('2026-09-25T14:05:00Z'))).toBe(1);
    const id = workflowInstanceId('publish', operationId);
    expect(f.createBatch).toHaveBeenCalledWith([{ id, params: { jobId: 'j', localizationLocales: ['pt-BR'] } }]);
    expect(f.sqlite.prepare("select status,workflow_id,publication_operation_id,publication_locales_json from jobs where id='j'").get())
      .toEqual({ status: 'publishing', workflow_id: id, publication_operation_id: operationId, publication_locales_json: '["pt-BR"]' });
    f.sqlite.prepare("update sites set publication_language_mode='source_only' where id='s'").run();
    expect(await reconcilePublicationDispatches(f.env, new Date('2026-09-25T14:08:00Z'))).toBe(1);
    expect(f.createBatch).toHaveBeenLastCalledWith([{ id, params: { jobId: 'j', localizationLocales: ['pt-BR'] } }]);
  });

  it('does not dispatch when provider status is uncertain', async () => {
    const f = fixture(workflowInstanceId('publish', operationId));
    f.get.mockRejectedValueOnce(new Error('network unavailable'));
    expect(await reconcilePublicationDispatches(f.env, new Date('2026-09-25T14:05:00Z'))).toBe(0);
    expect(f.createBatch).not.toHaveBeenCalled();
  });
});
