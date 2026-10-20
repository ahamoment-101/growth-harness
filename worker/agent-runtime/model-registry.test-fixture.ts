import type { ModelProfile, ResolvedModelProfile } from './model-registry';

export function testModelProfile(overrides: Partial<ResolvedModelProfile> = {}): ResolvedModelProfile {
  return {
    id: 'fixture/model', connection: 'fixture', provider: 'fixture', protocol: 'openai-chat',
    baseUrl: 'https://model.invalid/v1', apiKey: 'test-key', keyName: 'MODEL_API_KEY',
    model: 'fixture-model', contextWindow: 128_000, maxOutputTokens: 32_000,
    supportedParameters: ['tools', 'tool_choice', 'reasoning', 'max_tokens'],
    reasoningSupported: true, reasoningRequired: false,
    sourceUrl: 'https://model.invalid/fixture-contract', ...overrides,
  };
}

export function testModelRegistry(
  profiles: Record<string, ResolvedModelProfile>,
  defaultProfile = Object.keys(profiles)[0],
  agentProfiles: Record<string, string> = {},
): string {
  const connections: Record<string, unknown> = {};
  const models: Record<string, ModelProfile> = {};
  for (const [id, value] of Object.entries(profiles)) {
    const { id: _id, provider, protocol, baseUrl, apiKey: _key, keyName, headers, reasoningEffort: _effort, ...profile } = value;
    const connection = provider || profile.connection;
    connections[connection] = { protocol, baseUrl, apiKeyEnv: keyName, ...(headers ? { headers } : {}) };
    models[id] = { ...profile, connection };
  }
  return JSON.stringify({ version: 2, defaultProfile, agentProfiles, connections, profiles: models });
}
