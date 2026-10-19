// @ts-ignore Node-only fixture
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { createConversation, enqueueInput, wakeConversation } from './service';
import { agentDefinition } from '../agent-runtime/definitions';
import { dispatchDailyTriggers, nextDailyDue, readDailyTrigger, saveDailyTrigger } from './daily-triggers';

vi.mock('./service', () => ({ createConversation: vi.fn(), enqueueInput: vi.fn(), wakeConversation: vi.fn() }));

function fixture() {
  const f = taskTestDb();
  f.sqlite.exec("alter table sites add column workspace_id text not null default 'w'");
  f.sqlite.exec(readFileSync(new URL('../../migrations/0080_daily_triggers.sql', import.meta.url).pathname, 'utf8'));
  return { ...f, env: { DB: f.db } as RuntimeAgentEnv };
}

const config = { enabled: true, task_mode: 'scheduled', action: 'start_topic_batch', local_time: '09:00' } as const;

describe('daily Leader triggers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('schedules against China time and validates the only supported action', async () => {
    expect(nextDailyDue('09:00', new Date('2026-09-26T00:59:00Z'))).toBe('2026-09-26T01:00:00.000Z');
    expect(nextDailyDue('09:00', new Date('2026-09-26T01:00:00Z'))).toBe('2026-09-27T01:00:00.000Z');
    const f = fixture();
    await expect(saveDailyTrigger(f.db, 'w', 's', { ...config, action: 'unknown' })).rejects.toThrow('Invalid trigger configuration');
    await expect(saveDailyTrigger(f.db, 'other', 's', config)).rejects.toThrow('Site does not exist');
    const saved = await saveDailyTrigger(f.db, 'w', 's', config, new Date('2026-09-26T00:59:00Z'));
    expect(saved.next_due_at).toBe('2026-09-26T01:00:00.000Z');
    expect((await readDailyTrigger(f.db, 'w', 's'))?.timezone).toBe('Asia/Shanghai');
  });

  it('records one local-day occurrence and retries delivery with the same input', async () => {
    const f = fixture();
    await saveDailyTrigger(f.db, 'w', 's', config, new Date('2026-09-26T00:59:00Z'));
    vi.mocked(wakeConversation).mockRejectedValueOnce(new Error('dispatch unavailable'));
    const at = new Date('2026-09-26T01:00:00Z');
    await dispatchDailyTriggers(f.env, at);
    expect(f.sqlite.prepare('select local_date,delivered_at from daily_trigger_fires').all()).toEqual([{ local_date: '2026-09-26', delivered_at: '' }]);
    await dispatchDailyTriggers(f.env, at);
    expect(f.sqlite.prepare('select count(*) n from daily_trigger_fires').get()).toEqual({ n: 1 });
    expect(vi.mocked(enqueueInput).mock.calls.map(call => call[3].id)).toEqual([
      'daily-trigger:s:2026-09-26', 'daily-trigger:s:2026-09-26',
    ]);
    expect(vi.mocked(createConversation)).toHaveBeenCalledWith(f.env, { workspaceId: 'w', siteId: 's' },
      expect.objectContaining({ id: 'daily-topics:s:2026-09-26' }));
    expect(vi.mocked(wakeConversation)).toHaveBeenCalledWith(f.env, { workspaceId: 'w', siteId: 's' },
      'daily-topics:s:2026-09-26', 'daily-trigger:s:2026-09-26');
    expect(agentDefinition('growth_leader').runPolicy.allowScheduled).toBe(true);
    const delivered = f.sqlite.prepare('select delivered_at from daily_trigger_fires').get() as { delivered_at: string };
    expect(delivered.delivered_at).not.toBe('');
  });

  it('does not dispatch while disabled', async () => {
    const f = fixture();
    await saveDailyTrigger(f.db, 'w', 's', { ...config, enabled: false }, new Date('2026-09-26T00:59:00Z'));
    await dispatchDailyTriggers(f.env, new Date('2026-09-26T01:00:00Z'));
    expect(f.sqlite.prepare('select count(*) n from daily_trigger_fires').get()).toEqual({ n: 0 });
    expect(wakeConversation).not.toHaveBeenCalled();
  });
});
