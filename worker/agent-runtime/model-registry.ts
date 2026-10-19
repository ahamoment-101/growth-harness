import { parseModelRegistry } from '../../shared/config/models';
import type { AgentId } from '../../shared/agent-ids';
import type { ModelRegistryEnv, ResolvedModelProfile, ModelProfile } from '../../shared/config/models';
export * from '../../shared/config/models';

/** Resolve every model fact through one registry entry. Callers never combine a
 * provider, model ID, endpoint, capacity, or request dialect independently. */
export function resolveModelProfile<T extends ModelRegistryEnv>(env: T, agentId?: AgentId): ResolvedModelProfile {
  const registry = parseModelRegistry(env);
  const id = agentId ? registry.agentProfiles[agentId] || registry.defaultProfile : registry.defaultProfile;
  const profile = registry.profiles[id];
  const connection = registry.connections[profile.connection];
  const keyName = connection.apiKeyEnv;
  const value = (env as Record<string, unknown>)[keyName];
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (!apiKey) throw new Error(`${keyName} is not set`);
  return { ...profile, id, provider: profile.connection, protocol: connection.protocol,
    baseUrl: connection.baseUrl.replace(/\/+$/, ''), headers: connection.headers, apiKey, keyName };
}

export function maximumGenerationTokens(profile: Pick<ModelProfile, 'model' | 'contextWindow' | 'maxOutputTokens'>): number {
  if (!Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens <= 0 ||
    !Number.isSafeInteger(profile.contextWindow) || profile.contextWindow <= 0) {
    throw new Error(`Model capacity is unknown: ${profile.model}`);
  }
  return profile.maxOutputTokens;
}

export function effectiveMaxOutputTokens(desired: number, profile: Pick<ModelProfile, 'maxOutputTokens'>): number {
  if (!Number.isSafeInteger(desired) || desired <= 0) throw new Error('Desired output tokens must be a positive integer');
  return Math.min(desired, profile.maxOutputTokens);
}

const REASONING_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high'] as const;

export function effectiveReasoning(
  requested: 'none' | 'minimal' | 'low' | 'medium' | 'high',
  profile: Pick<ModelProfile, 'reasoningSupported' | 'reasoningRequired' | 'minimumReasoningEffort'>,
): 'none' | 'minimal' | 'low' | 'medium' | 'high' | undefined {
  if (!profile.reasoningSupported) return undefined;
  if (profile.minimumReasoningEffort) {
    return REASONING_EFFORT_ORDER.indexOf(requested) < REASONING_EFFORT_ORDER.indexOf(profile.minimumReasoningEffort)
      ? profile.minimumReasoningEffort
      : requested;
  }
  return profile.reasoningRequired && requested === 'none' ? 'minimal' : requested;
}
