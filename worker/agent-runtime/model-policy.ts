import { observedFetch } from './request-accounting';
import { executionFailure, ExecutionFailureError } from './execution-failure';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { ResolvedModelProfile } from './model-registry';
import { channelRequestBody } from '../lib/model-channel';

/** Compatibility for the legacy probe; business loops use conversationChannel. */
export function runtimeChannelModel(profile: ResolvedModelProfile): LanguageModel {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    try {
      const transformed = typeof init?.body === 'string'
        ? { ...init, body: JSON.stringify(channelRequestBody(profile, JSON.parse(init.body))) } : init;
      return await observedFetch(input, transformed);
    } catch (error) {
      const failure = executionFailure(error, 'model_fetch');
      if (failure) throw new ExecutionFailureError(failure);
      throw error;
    }
  };
  const options = { apiKey: profile.apiKey, baseURL: profile.baseUrl, headers: profile.headers, fetch };
  if (profile.protocol === 'anthropic-messages') return createAnthropic(options)(profile.model);
  if (profile.protocol === 'openai-responses') return createOpenAI(options).responses(profile.model);
  return createOpenAICompatible({ ...options, name: profile.provider })(profile.model);
}

export function runtimeActionRequestContract() {
  return {
    toolChoice: 'required' as const,
    system: 'Runtime action contract: return exactly one tool call per decision. Choose the next action only; further actions can be chosen after observing its result. Never bundle multiple calls. Tool schemas define required fields and allowed values; no action executes until validated.',
  };
}
