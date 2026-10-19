import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai';
import { requestCapacity } from './request-capacity';
import { conversationMessage } from './message-view';

type CapacityAnchor = { measurementVersion: number; provider: string; model: string; endpoint: string; prefixHash: string; estimatedInput: number; actualInput: number };
const MEASUREMENT_VERSION = 2;
type MeasuredAssistant = AssistantMessage & { runtimeCapacity?: CapacityAnchor };
type ModelIdentity = Pick<Model<Api>, 'provider' | 'id' | 'baseUrl' | 'contextWindow' | 'maxTokens'>;

async function prefixHash(context: Context) {
  // Include native content (including any provider replay blocks), not the lossy
  // summary view. Host accounting does not affect the provider request prefix.
  const value = { systemPrompt: context.systemPrompt,
    tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
    messages: context.messages.map(message => {
      const { runtimeCapacity: _anchor, ...native } = conversationMessage(message) as typeof message & { runtimeCapacity?: CapacityAnchor };
      return native;
    }) };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function measuredAssistant(response: AssistantMessage, context: Context, model: ModelIdentity): Promise<AssistantMessage> {
  const actualInput = response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
  if (!Number.isSafeInteger(actualInput) || actualInput <= 0 || ['error', 'aborted'].includes(response.stopReason)) return response;
  const runtimeCapacity: CapacityAnchor = { measurementVersion: MEASUREMENT_VERSION, provider: model.provider, model: model.id, endpoint: model.baseUrl || '',
    prefixHash: await prefixHash(context), actualInput,
    estimatedInput: requestCapacity(context, model.contextWindow, model.maxTokens).estimatedInputTokens };
  return { ...response, runtimeCapacity } as MeasuredAssistant;
}

export async function calibratedRequestCapacity(context: Context, model: ModelIdentity) {
  const baseline = requestCapacity(context, model.contextWindow, model.maxTokens);
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    const anchor = message.role === 'assistant' ? (message as MeasuredAssistant).runtimeCapacity : undefined;
    if (!anchor || anchor.measurementVersion !== MEASUREMENT_VERSION || anchor.provider !== model.provider || anchor.model !== model.id || anchor.endpoint !== (model.baseUrl || '')) continue;
    // One comparison per request. After context maintenance, recompute from the
    // new view rather than hashing every historical prefix in quadratic time.
    if (await prefixHash({ ...context, messages: context.messages.slice(0, index) }) !== anchor.prefixHash) return baseline;
    const estimatedInputTokens = anchor.actualInput + Math.max(0, baseline.estimatedInputTokens - anchor.estimatedInput);
    return { ...baseline, estimatedInputTokens, measurement: 'provider_usage_plus_delta' as const,
      fits: baseline.known && estimatedInputTokens + model.maxTokens <= model.contextWindow,
      allowedOutputTokens: baseline.known ? Math.max(0, Math.min(model.maxTokens, model.contextWindow - estimatedInputTokens)) : 0 };
  }
  return baseline;
}
