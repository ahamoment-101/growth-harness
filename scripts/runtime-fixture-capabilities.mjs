// Synthetic capabilities only; this is not a real endpoint claim.
export const fixtureModelRegistry = JSON.stringify({
  version: 2, defaultProfile: 'fixture/model', agentProfiles: {},
  connections: { fixture: { protocol: 'openai-chat', baseUrl: 'https://model.invalid/v1', apiKeyEnv: 'MODEL_API_KEY' } },
  profiles: { 'fixture/model': {
    connection: 'fixture', model: 'fixture-model', contextWindow: 128000, maxOutputTokens: 32000,
    supportedParameters: ['tools', 'max_tokens'], reasoningSupported: false, reasoningRequired: false,
    sourceUrl: 'https://model.invalid/fixture-contract',
  } },
});
