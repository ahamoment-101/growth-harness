import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { startConversation } from './service';

function fixture() {
  const f = schemaTestDb();
  // Match D1's all-or-nothing batch contract, including a failure in the second write.
  const batch = f.db.batch.bind(f.db);
  f.db.batch = async <T,>(statements: D1PreparedStatement[]) => {
    f.sqlite.exec('begin');
    try { const result = await batch<T>(statements); f.sqlite.exec('commit'); return result; }
    catch (error) { f.sqlite.exec('rollback'); throw error; }
  };
  f.insert('sites', { id: 's', workspace_id: 'primary-workspace' });
  f.insert('sites', { id: 'other', workspace_id: 'primary-workspace' });
  const env = { DB: f.db } as RuntimeAgentEnv;
  const scope = { workspaceId: 'primary-workspace', siteId: 's' };
  const input = { id: crypto.randomUUID(), title: 'First goal', message: { id: crypto.randomUUID(), text: 'Research an article' } };
  const counts = () => [f.sqlite.prepare('select count(*) n from leader_conversations').get()!.n, f.sqlite.prepare('select count(*) n from leader_inputs').get()!.n];
  return { ...f, env, scope, input, counts };
}

describe('First Leader message acceptance', () => {
  it('atomically accepts once and replays the same message without duplicating input', async () => {
    const f = fixture();
    await startConversation(f.env, f.scope, f.input, 'owner');
    await startConversation(f.env, f.scope, f.input, 'owner');
    expect(f.counts()).toEqual([1, 1]);
  });

  it('rolls back the new conversation if the message identity belongs to another conversation', async () => {
    const f = fixture();
    await startConversation(f.env, f.scope, f.input, 'owner');
    await expect(startConversation(f.env, f.scope, { ...f.input, id: crypto.randomUUID() }, 'owner')).rejects.toThrow();
    expect(f.counts()).toEqual([1, 1]);
  });

  it('rejects changed payloads, actor identities, and cross-site replays while preserving accepted work', async () => {
    const f = fixture();
    await startConversation(f.env, f.scope, f.input, 'owner');
    await expect(startConversation(f.env, f.scope, { ...f.input, message: { ...f.input.message, text: 'Changed' } }, 'owner')).rejects.toThrow();
    await expect(startConversation(f.env, f.scope, f.input, 'someone-else')).rejects.toThrow();
    await expect(startConversation(f.env, { ...f.scope, siteId: 'other' }, f.input, 'owner')).rejects.toThrow();
    expect(f.counts()).toEqual([1, 1]);
    expect(f.sqlite.prepare('select content from leader_inputs').get()!.content).toBe(f.input.message.text);
  });

  it('does not create a conversation in a missing or foreign site', async () => {
    const f = fixture();
    await expect(startConversation(f.env, { ...f.scope, siteId: 'missing' }, f.input, 'owner')).rejects.toThrow();
    await expect(startConversation(f.env, { ...f.scope, workspaceId: 'foreign' }, f.input, 'owner')).rejects.toThrow();
    expect(f.counts()).toEqual([0, 0]);
  });
});
