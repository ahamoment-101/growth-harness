import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, FetchFunction, Model } from '@earendil-works/pi-ai';
import { streamSimple as streamChat } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as streamResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { channelRequestBody } from '../lib/model-channel';
import { effectiveReasoning, type ResolvedModelProfile } from './model-registry';
import { observedFetch } from './request-accounting';
import { RUNTIME_MODEL_REQUEST_TIMEOUT_MS } from './runtime-limits';

/** The host retains durable reservation, cancellation, accounting and tool authority. */
export function conversationChannel(
  profile: ResolvedModelProfile,
  fetch: FetchFunction = observedFetch,
): { model: Model<Api>; stream: StreamFn } {
  const api = profile.protocol === 'openai-chat' ? 'openai-completions' : profile.protocol;
  const model: Model<Api> = {
    id: profile.model, name: profile.model, api,
    provider: profile.provider, baseUrl: api === 'anthropic-messages' ? profile.baseUrl.replace(/\/v1$/, '') : profile.baseUrl, headers: profile.headers,
    reasoning: profile.reasoningSupported, input: ['text'],
    contextWindow: profile.contextWindow, maxTokens: profile.maxOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: api === 'openai-completions' ? {
      supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
      supportsUsageInStreaming: true, maxTokensField: 'max_tokens', thinkingFormat: 'openai', ...profile.compatibility,
    } : api === 'openai-responses' ? { supportsDeveloperRole: false, supportsStrictMode: false }
      : { forceAdaptiveThinking: profile.compatibility?.forceAdaptiveThinking },
  };
  return {
    model,
    stream: (_model, context, options) => {
      const effort = effectiveReasoning(options?.reasoning ?? profile.reasoningEffort ?? 'none', profile);
      const settings = {
        ...options, apiKey: profile.apiKey, fetch: options?.fetch || fetch, maxRetries: 0,
        reasoning: effort === 'none' ? undefined : effort,
        ...(profile.compatibility?.thinkingBudgetTokens ? { thinkingBudgets: {
          minimal: profile.compatibility.thinkingBudgetTokens, low: profile.compatibility.thinkingBudgetTokens,
          medium: profile.compatibility.thinkingBudgetTokens, high: profile.compatibility.thinkingBudgetTokens,
        } } : {}),
        timeoutMs: RUNTIME_MODEL_REQUEST_TIMEOUT_MS,
        signal: AbortSignal.any([AbortSignal.timeout(RUNTIME_MODEL_REQUEST_TIMEOUT_MS), ...(options?.signal ? [options.signal] : [])]),
        onPayload: async (payload: unknown) => {
          const wire = channelRequestBody(profile, payload as Record<string, unknown>);
          await options?.onPayload?.(wire, model);
          return wire;
        },
      };
      if (api === 'anthropic-messages') return streamAnthropic(model as Model<'anthropic-messages'>, context, settings);
      if (api === 'openai-responses') return streamResponses(model as Model<'openai-responses'>, context, settings);
      return streamChat(model as Model<'openai-completions'>, context, settings);
    },
  };
}
