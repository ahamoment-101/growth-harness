// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { agentCommandFailure, assertExplicitChatControl, chatMessageText, executeAgentCommand } from './commands';

function commandDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`create table agent_commands (
    id text primary key, run_id text, command text, actor_id text, source text, status text,
    payload_json text, result_json text, error text, created_at text, finished_at text
  )`);
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values as never[]).changes } }),
        first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
      }),
    }),
  } as unknown as D1Database;
}

describe('Agent command policy', () => {
  it('maps stable command failures to actionable HTTP statuses', () => {
    expect(agentCommandFailure(new Error('Agent Runtime is disabled')).status).toBe(503);
    expect(agentCommandFailure(new Error('Agent run not found')).status).toBe(404);
    expect(agentCommandFailure(new Error('Only failed or cancelled runs can be retried')).status).toBe(409);
    expect(agentCommandFailure(new Error('unexpected failure')).status).toBe(500);
  });
  it('extracts only the latest user text and requires explicit control intent', () => {
    const text = chatMessageText({ role: 'user', parts: [{ type: 'text', text: 'Please cancel this Run' }, { type: 'data', value: 'ignore' }] });
    expect(text).toBe('Please cancel this Run');
    expect(() => assertExplicitChatControl(text, 'cancel')).not.toThrow();
    expect(() => assertExplicitChatControl('Explain why the decision was made this way', 'cancel')).toThrow('explicitly');
    expect(() => assertExplicitChatControl('The earlier message said to cancel, but I only want to understand the rationale', 'approve')).toThrow('explicitly');
  });

  it('executes the same command id only once and replays its stored result', async () => {
    const db = commandDb();
    const action = vi.fn(async () => ({ cancelled: true }));
    const input = { commandId: 'command-1', runId: 'run-1', command: 'cancel' as const, actorId: 'user-1', source: 'ui' as const };
    await expect(executeAgentCommand(db, input, action)).resolves.toEqual({ cancelled: true });
    await expect(executeAgentCommand(db, input, action)).resolves.toEqual({ cancelled: true });
    expect(action).toHaveBeenCalledOnce();
  });

  it('settles a processing command from durable state without repeating its action', async () => {
    const db = commandDb();
    await db.prepare(
      `insert into agent_commands values
       ('command-recover', 'run-1', 'cancel', 'user-1', 'ui', 'processing', '{}', '{}', '', '2026-08-24T00:00:00Z', '')`,
    ).bind().run();
    const action = vi.fn(async () => ({ status: 'cancelled' }));
    const recovered = vi.fn(async () => ({ status: 'cancelled' }));
    await expect(executeAgentCommand(db, {
      commandId: 'command-recover', runId: 'run-1', command: 'cancel', actorId: 'user-1', source: 'ui',
    }, action, recovered)).resolves.toEqual({ status: 'cancelled' });
    expect(action).not.toHaveBeenCalled();
    expect(recovered).toHaveBeenCalledOnce();
  });
});
