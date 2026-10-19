import { describe, expect, it, vi } from 'vitest';
import { persistAgentActionPayload, readAgentActionPayload } from './action-payloads';

describe('Agent action payload persistence', () => {
  it('stores large working candidates by reference and enforces Run lineage on reads', async () => {
    let stored: unknown[] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => { stored = args; return { meta: { changes: 1 } }; },
          first: async () => {
            if (!sql.includes('select payload_json')) return null;
            const [id, runId, workspaceId, siteId] = args;
            return id === stored[0] && runId === stored[1] && workspaceId === stored[2] && siteId === stored[3]
              ? { payload_json: stored[8] }
              : null;
          },
        }),
      })),
    };
    const payload = { article: 'Content'.repeat(30_000), api_key: 'must-not-persist' };
    const ref = await persistAgentActionPayload(db as never, {
      runId: 'run-1', workspaceId: 'workspace-1', siteId: 'site-1', decisionTurn: 1,
      toolName: 'submit_article', direction: 'input', payload,
    });
    expect(ref.byte_length).toBeGreaterThan(payload.article.length);
    await expect(readAgentActionPayload(db as never, {
      payloadRef: ref.payload_ref, runId: 'run-1', workspaceId: 'workspace-1', siteId: 'site-1',
    })).resolves.toEqual({ article: payload.article, api_key: '[redacted]' });
    await expect(readAgentActionPayload(db as never, {
      payloadRef: ref.payload_ref, runId: 'another-run', workspaceId: 'workspace-1', siteId: 'site-1',
    })).resolves.toBeNull();
  });
});
