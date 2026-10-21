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

  it('rejects a first message before creating an empty conversation', async () => {
    const prepare = vi.fn(() => { throw new Error('No writes expected'); });
    const env = { DB: { prepare } } as unknown as RuntimeAgentEnv;
    const ctx = { waitUntil: vi.fn() };
    const response = await handleLeaderRequest(new Request('https://example.invalid/start', { method: 'POST',
      body: JSON.stringify({ id: crypto.randomUUID(), title: 'First task', message: { id: crypto.randomUUID(), text: 'Research' } }),
    }), env, { workspaceId: 'w', siteId: 's' }, 'owner', 'start', ctx);
    expect(response.status).toBe(503);
    expect(prepare).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('reports the selected key without exposing credentials or invoking a model', async () => {
    const env = { MODEL_REGISTRY: testModelRegistry({ selected: testModelProfile({ keyName: 'SELECTED_MODEL_KEY' }) }, 'selected'),
      OPENROUTER_API_KEY: 'unrelated-secret' } as unknown as RuntimeAgentEnv;
    const read = () => handleLeaderRequest(new Request('https://example.invalid/configuration'), env,
      { workspaceId: 'w', siteId: 's' }, 'owner', 'configuration', { waitUntil: vi.fn() });
    const response = await read();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const missing = await response.json() as { message: string };
    expect(missing).toMatchObject({ state: 'missing', key: 'SELECTED_MODEL_KEY' });
    // Before any task exists, setup guidance must not promise to resume one.
    expect(missing.message).not.toMatch(/resume|existing task/i);
    Object.assign(env, { SELECTED_MODEL_KEY: 'configured-secret' });
    expect(await (await read()).json()).toEqual({ state: 'configured' });
    env.MODEL_REGISTRY = '{invalid-secret';
    const invalid = await (await read()).json();
    expect(invalid).toEqual({ state: 'invalid', message: expect.stringContaining('MODEL_REGISTRY') });
    expect(JSON.stringify(invalid)).not.toContain('invalid-secret');
  });
