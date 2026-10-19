import { describe, expect, it } from 'vitest';
import { effectiveMaxOutputTokens, effectiveReasoning, maximumGenerationTokens, parseModelRegistry, selectedModelKeyNames, resolveModelProfile } from './model-registry';
import { testModelProfile, testModelRegistry } from './model-registry.test-fixture';

function environment(agentProfiles: Record<string, string> = {}) {
  const chat = testModelProfile({ id: 'primary', provider: 'my-gateway', keyName: 'MY_GATEWAY_KEY' });
  const native = testModelProfile({ id: 'native', provider: 'direct', protocol: 'anthropic-messages', keyName: 'DIRECT_KEY' });
  return { MODEL_REGISTRY: testModelRegistry({ primary: chat, native }, 'primary', agentProfiles), MY_GATEWAY_KEY: 'first-key', DIRECT_KEY: 'second-key' };
}

describe('model registry connections', () => {
  it('accepts a user-named connection and credential variable without a vendor code change', () => {
    const profile = resolveModelProfile(environment());
    expect(profile).toMatchObject({ provider: 'my-gateway', keyName: 'MY_GATEWAY_KEY', apiKey: 'first-key', protocol: 'openai-chat' });
  });

  it('binds Agents independently while unused connections do not require credentials', () => {
    const env = environment({ article_production: 'native' });
    expect(resolveModelProfile(env, 'article_production')).toMatchObject({ provider: 'direct', protocol: 'anthropic-messages', apiKey: 'second-key' });
    expect(resolveModelProfile({ ...environment(), DIRECT_KEY: '' })).toMatchObject({ id: 'primary' });
    expect(selectedModelKeyNames(parseModelRegistry(env))).toEqual(['MY_GATEWAY_KEY', 'DIRECT_KEY']);
  });

  it('never falls back to another connection key', () => {
    const env = { ...environment(), MY_GATEWAY_KEY: '' };
    expect(() => resolveModelProfile(env)).toThrow('MY_GATEWAY_KEY is not set');
  });

  it('preserves verified capacity and reasoning constraints', () => {
    const profile = resolveModelProfile(environment());
    expect(maximumGenerationTokens(profile)).toBe(32_000);
    expect(effectiveMaxOutputTokens(64_000, profile)).toBe(32_000);
    expect(effectiveReasoning('none', { ...profile, reasoningRequired: true, minimumReasoningEffort: 'low' })).toBe('low');
    expect(effectiveReasoning('high', { ...profile, reasoningSupported: false })).toBeUndefined();
  });

  it('rejects invalid references, protocols, capacity and unregistered dialects', () => {
    const base = JSON.parse(environment().MODEL_REGISTRY);
    for (const patch of [
      { defaultProfile: 'absent' },
      { agentProfiles: { unknown_agent: 'primary' } },
      { connections: { ...base.connections, 'my-gateway': { ...base.connections['my-gateway'], protocol: 'unknown' } } },
      { profiles: { primary: { ...base.profiles.primary, connection: 'absent' } } },
      { profiles: { primary: { ...base.profiles.primary, maxOutputTokens: base.profiles.primary.contextWindow } } },
      { profiles: { primary: { ...base.profiles.primary, requestDialect: 'unregistered-dialect' } } },
    ]) expect(() => parseModelRegistry({ MODEL_REGISTRY: JSON.stringify({ ...base, ...patch }) })).toThrow();
  });

  it('rejects inline secrets and redacts schema diagnostics', () => {
    const base = JSON.parse(environment().MODEL_REGISTRY);
    for (const patch of [
      { apiKey: 'DO-NOT-LOG-THIS' }, { headers: { Authorization: 'DO-NOT-LOG-THIS' } },
      { baseUrl: 'https://user:DO-NOT-LOG-THIS@model.invalid/v1' },
    ]) {
      const registry = { ...base, connections: { ...base.connections, 'my-gateway': { ...base.connections['my-gateway'], ...patch } } };
      let failure: unknown;
      try { parseModelRegistry({ MODEL_REGISTRY: JSON.stringify(registry) }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain('DO-NOT-LOG-THIS');
    }
  });
});
