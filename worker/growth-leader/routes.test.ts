import { describe, expect, it, vi } from 'vitest';
import { handleLeaderRequest } from './routes';
import { ModelConfigurationError } from '../agent-runtime/model-registry';
import { testModelProfile, testModelRegistry } from '../agent-runtime/model-registry.test-fixture';
import type { RuntimeAgentEnv } from '../agent-runtime/env';

describe('Leader message configuration preflight', () => {
  it.each([undefined, '', '   '])('returns actionable configuration feedback before accepting a message when the selected key is %s', async key => {
    const prepare = vi.fn(() => { throw new Error('No message or task should be written'); });
    const env = { DB: { prepare },
      MODEL_REGISTRY: testModelRegistry({ selected: testModelProfile({ keyName: 'SELECTED_MODEL_KEY' }) }, 'selected'),
      SELECTED_MODEL_KEY: key, OPENROUTER_API_KEY: 'unrelated-key',
    } as unknown as RuntimeAgentEnv;
    const ctx = { waitUntil: vi.fn() };
    const response = await handleLeaderRequest(new Request('https://example.invalid/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: crypto.randomUUID(), text: 'Research my next article' }),
    }), env, { workspaceId: 'w', siteId: 's' }, 'owner', `conversations/${crypto.randomUUID()}/messages`, ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'model_configuration_required', error: new ModelConfigurationError('SELECTED_MODEL_KEY').message });
    expect(prepare).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});
