// @ts-ignore Node-only fixture
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { isLeaderConversationResponseRoute } from './response-route';

describe('Leader HITL response route', () => {
  it('admits only a POST response for a conversation in the current workspace and site', async () => {
    const f = taskTestDb();
    f.sqlite.exec(readFileSync(new URL('../../migrations/0066_growth_leader.sql', import.meta.url).pathname, 'utf8'));
    f.sqlite.prepare('insert into leader_conversations(id,workspace_id,site_id,title,context,source_id,created_at) values(?,?,?,?,?,?,?)')
      .run('leader-conversation', 'w', 's', 'Current conversation', '', '', '2026-09-25');
    const input = { workspaceId: 'w', siteId: 's', agentId: 'growth_leader', taskId: 'leader-conversation', method: 'POST', responseAction: '/responses' };
    expect(await isLeaderConversationResponseRoute(f.db, input)).toBe(true);
    for (const change of [
      { workspaceId: 'other' }, { siteId: 'other' }, { agentId: 'business_research' },
      { taskId: 'another-conversation' }, { method: 'GET' }, { responseAction: undefined },
    ]) expect(await isLeaderConversationResponseRoute(f.db, { ...input, ...change })).toBe(false);
  });

  it('decodes the publication conversation path once while preserving ownership checks', async () => {
    const f = taskTestDb();
    f.sqlite.exec(readFileSync(new URL('../../migrations/0066_growth_leader.sql', import.meta.url).pathname, 'utf8'));
    f.sqlite.prepare('insert into leader_conversations(id,workspace_id,site_id,title,context,source_id,created_at) values(?,?,?,?,?,?,?)')
      .run('publication:s', 'w', 's', 'Publication review', '', '', '2026-10-19');
    const input = { workspaceId: 'w', siteId: 's', agentId: 'growth_leader', taskId: 'publication%3As', method: 'POST', responseAction: '/responses' };
    expect(await isLeaderConversationResponseRoute(f.db, input)).toBe(true);
    expect(await isLeaderConversationResponseRoute(f.db, { ...input, siteId: 'other' })).toBe(false);
    expect(await isLeaderConversationResponseRoute(f.db, { ...input, workspaceId: 'other' })).toBe(false);
    expect(await isLeaderConversationResponseRoute(f.db, { ...input, taskId: 'publication%253As' })).toBe(false);
    expect(await isLeaderConversationResponseRoute(f.db, { ...input, taskId: '%' })).toBe(false);
  });
});
