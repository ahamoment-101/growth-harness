import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import { createPractice, requireRecord, recordView } from './store';
import { dispatchLearningRequests } from './dispatch';
import { startRuntimeRun } from '../agent-runtime/run-service';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
vi.mock('../agent-runtime/run-service', () => ({ startRuntimeRun: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const scope = { workspaceId: 'primary-workspace', siteId: 's' };
function fixture() {
  const f = schemaTestDb();
  f.insert('sites', { id: 's', workspace_id: scope.workspaceId });
  return f;
}
describe('learning preparation dispatch', () => {
  it('persists three failed dispatches across ticks then unblocks business without disabling later work', async () => {
    const f = fixture(),
      env = { DB: f.db } as RuntimeAgentEnv;
    const record = await createPractice(
      f.db,
      scope,
      'topic',
      'topic_decision',
      'Pilot',
    );
    vi.mocked(startRuntimeRun).mockRejectedValue(
      new Error('Temporary host refusal'),
    );
    for (let i = 0; i < 3; i++) {
      f.sqlite
        .prepare(
          "update learning_requests set available_at='2000-01-01T00:00:00Z'",
        )
        .run();
      await dispatchLearningRequests(env);
      expect(
        f.sqlite.prepare('select failure_count from learning_requests').get(),
      ).toEqual({ failure_count: i + 1 });
    }
    expect(
      recordView(await requireRecord(f.db, scope, record.id)).experience
        .preparation,
    ).toBe('skipped');
    const ids = vi
      .mocked(startRuntimeRun)
      .mock.calls.map((call) => call[1].runId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^learning-[a-f0-9]{64}$/);
    const next = await createPractice(
      f.db,
      scope,
      'next',
      'topic_decision',
      'Next practice',
    );
    vi.mocked(startRuntimeRun).mockResolvedValue({} as never);
    await dispatchLearningRequests(env);
    expect(
      f.sqlite
        .prepare(
          'select status,failure_count from learning_requests where record_id=?',
        )
        .get(next.id),
    ).toEqual({ status: 'running', failure_count: 0 });
  });
  it('reconciles a saved request after an unknown dispatch response without counting a failure', async () => {
    const f = fixture(),
      env = { DB: f.db } as RuntimeAgentEnv;
    await createPractice(f.db, scope, 'topic', 'topic_decision', 'Pilot');
    vi.mocked(startRuntimeRun).mockImplementation(async () => {
      f.sqlite.prepare("update learning_requests set status='completed'").run();
      throw new Error('Connection lost after receipt');
    });
    await dispatchLearningRequests(env);
    expect(
      f.sqlite
        .prepare('select status,failure_count from learning_requests')
        .get(),
    ).toEqual({ status: 'completed', failure_count: 0 });
  });
});
