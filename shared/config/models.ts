import { z } from 'zod';
import { AGENT_IDS, type AgentId } from '../agent-ids.ts';
import { normalizeModelRegistry, supportedModelDialects } from './model-extensions.ts';

export const MODEL_PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages'] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];

export type ModelProfile = {
  connection: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportedParameters: string[];
  reasoningSupported: boolean;
  reasoningRequired: boolean;
  minimumReasoningEffort?: 'low';
  requestDialect?: string;
  compatibility?: {
    maxTokensField?: 'max_tokens' | 'max_completion_tokens';
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    supportsStore?: boolean;
    supportsStrictMode?: boolean;
    thinkingFormat?: 'openai' | 'openrouter';
    forceAdaptiveThinking?: boolean;
    thinkingBudgetTokens?: number;
  };
  sourceUrl: string;
};

export type ResolvedModelProfile = ModelProfile & {
  id: string;
  provider: string;
  protocol: ModelProtocol;
  baseUrl: string;
  headers?: Record<string, string>;
  apiKey: string;
  keyName: string;
};

export interface ModelRegistryEnv {
  MODEL_REGISTRY?: string;
}

const connectionSchema = z.object({
  protocol: z.enum(MODEL_PROTOCOLS),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Use an environment variable name, never a key value'),
  headers: z.record(z.string(), z.string()).optional(),
}).strict().superRefine((connection, context) => {
  const url = new URL(connection.baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: 'custom', message: 'Endpoint URLs cannot contain credentials, query parameters or fragments' });
  }
  if (Object.keys(connection.headers || {}).some(key => /authorization|api.key|cookie|token|secret/i.test(key))) {
    context.addIssue({ code: 'custom', message: 'Credentials belong in the environment variable referenced by apiKeyEnv' });
  }
});

const profileSchema = z.object({
  connection: z.string().trim().min(1),
  model: z.string().trim().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  supportedParameters: z.array(z.string().trim().min(1)),
  reasoningSupported: z.boolean(),
  reasoningRequired: z.boolean(),
  minimumReasoningEffort: z.literal('low').optional(),
  requestDialect: z.string().optional(),
  compatibility: z.object({
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    supportsUsageInStreaming: z.boolean().optional(),
    supportsStore: z.boolean().optional(),
    supportsStrictMode: z.boolean().optional(),
    thinkingFormat: z.enum(['openai', 'openrouter']).optional(),
    forceAdaptiveThinking: z.boolean().optional(),
    thinkingBudgetTokens: z.number().int().positive().optional(),
  }).strict().optional(),
  sourceUrl: z.string().url(),
}).strict().superRefine((profile, context) => {
  if (profile.maxOutputTokens >= profile.contextWindow) {
    context.addIssue({ code: 'custom', message: 'Output allowance must leave room for input' });
  }
  if (profile.reasoningRequired && !profile.reasoningSupported) {
    context.addIssue({ code: 'custom', message: 'Required reasoning must be supported' });
  }
  if (profile.requestDialect && !supportedModelDialects.includes(profile.requestDialect)) {
    context.addIssue({ code: 'custom', message: 'The configured request dialect is not registered in this distribution' });
  }
});

const registrySchema = z.object({
  version: z.literal(2),
  defaultProfile: z.string().trim().min(1),
  agentProfiles: z.record(z.string(), z.string().trim().min(1)),
  connections: z.record(z.string(), connectionSchema),
  profiles: z.record(z.string(), profileSchema),
}).strict();

export type ModelRegistry = z.infer<typeof registrySchema>;
export type ModelConnection = z.infer<typeof connectionSchema>;

export function parseModelRegistry(env: ModelRegistryEnv): ModelRegistry {
  if (!env.MODEL_REGISTRY?.trim()) throw new Error('MODEL_REGISTRY is not configured');
  let registry: ModelRegistry;
  // Schema errors can contain rejected values; never expose them to clients or logs.
  try { registry = registrySchema.parse(normalizeModelRegistry(JSON.parse(env.MODEL_REGISTRY))); }
  catch { throw new Error('MODEL_REGISTRY is invalid. Use version 2 connections, registered protocols and complete model capabilities; keep credentials in environment variables.'); }
  const unknownAgents = Object.keys(registry.agentProfiles).filter(id => !AGENT_IDS.includes(id as AgentId));
  if (unknownAgents.length) throw new Error(`MODEL_REGISTRY contains unknown Agent IDs: ${unknownAgents.join(', ')}`);
  const referenced = new Set([registry.defaultProfile, ...Object.values(registry.agentProfiles)]);
  const missing = [...referenced].filter(id => !registry.profiles[id]);
  if (missing.length) throw new Error(`MODEL_REGISTRY references missing profiles: ${missing.join(', ')}`);
  for (const profile of Object.values(registry.profiles)) {
    if (!registry.connections[profile.connection]) throw new Error('MODEL_REGISTRY references a missing connection');
    if (registry.connections[profile.connection].protocol === 'anthropic-messages' && profile.reasoningRequired &&
      !profile.compatibility?.forceAdaptiveThinking && !profile.compatibility?.thinkingBudgetTokens) {
      throw new Error('Required Anthropic thinking needs verified adaptive-thinking support or a thinking token budget');
    }
    if ((profile.compatibility?.thinkingBudgetTokens || 0) >= profile.maxOutputTokens) {
      throw new Error('Thinking budget must leave room for output');
    }
  }
  return registry;
}

export function selectedModelKeyNames(registry: ModelRegistry): string[] {
  const profiles = new Set([registry.defaultProfile, ...Object.values(registry.agentProfiles)]);
  return [...new Set([...profiles].map(id => registry.connections[registry.profiles[id].connection].apiKeyEnv))];
}

