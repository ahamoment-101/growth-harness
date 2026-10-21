import { parseModelRegistry } from '../../shared/config/models';
import type { AgentId } from '../../shared/agent-ids';
import { REASONING_EFFORTS, type ReasoningEffort, type ModelRegistryEnv, type ResolvedModelProfile, type ModelProfile } from '../../shared/config/models';
export * from '../../shared/config/models';

/** A local configuration defect cannot be repaired by replacing an execution host. */
export class ModelConfigurationError extends Error {
  readonly code = 'model_configuration_required';
  constructor(readonly keyName: string) {
    super(`${keyName} is not set. Add it to .dev.vars for local development or Cloudflare Secrets for deployment, then restart or redeploy. Your existing task can resume after configuration is restored.`);
    this.name = 'ModelConfigurationError';
  }
}

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
  if (!apiKey) throw new ModelConfigurationError(keyName);
  return { ...profile, id, provider: profile.connection, protocol: connection.protocol,
    baseUrl: connection.baseUrl.replace(/\/+$/, ''), headers: connection.headers, apiKey, keyName,
    reasoningEffort: (agentId && registry.agentReasoning[agentId]) || registry.defaultReasoning };
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

export function effectiveReasoning(
  requested: ReasoningEffort,
  profile: Pick<ModelProfile, 'reasoningSupported' | 'reasoningRequired' | 'minimumReasoningEffort'>,
): ReasoningEffort | undefined {
  if (!profile.reasoningSupported) return undefined;
  if (profile.minimumReasoningEffort) {
    return REASONING_EFFORTS.indexOf(requested) < REASONING_EFFORTS.indexOf(profile.minimumReasoningEffort)
      ? profile.minimumReasoningEffort
      : requested;
  }
  return profile.reasoningRequired && requested === 'none' ? 'minimal' : requested;
}
