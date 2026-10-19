import type { ResolvedModelProfile } from '../../shared/config/models';
import { effectiveMaxOutputTokens, effectiveReasoning } from '../agent-runtime/model-registry';
import { channelRequestBody } from './model-channel';

export type ModelTextMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type ModelTextOptions = {
  messages: ModelTextMessage[];
  maxTokens?: number;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  timeoutMs?: number;
};
export type ModelTextResult = {
  content: string;
  finishReason: string;
  provider: string;
  model: string;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  citations: Array<{ url: string; title: string; content: string }>;
};

export class ModelHttpError extends Error {
  constructor(public status: number, body: string) {
    super(`Model ${status}: ${body.slice(0, 500)}`);
    this.name = 'ModelHttpError';
  }
}

/** All non-streaming text consumers use the same protocol and credential resolution. */
export async function requestModelText(profile: ResolvedModelProfile, options: ModelTextOptions): Promise<ModelTextResult> {
  const effort = effectiveReasoning(options.reasoningEffort || 'none', profile);
  const maxTokens = options.maxTokens ? effectiveMaxOutputTokens(options.maxTokens, profile) : profile.maxOutputTokens;
  const system = options.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const messages = options.messages.filter(message => message.role !== 'system');
  const schema = options.jsonSchema;
  let path: string;
  let body: Record<string, unknown>;
  const headers = new Headers(profile.headers);
  headers.set('Content-Type', 'application/json');
  if (profile.protocol === 'anthropic-messages') {
    path = '/messages';
    headers.set('x-api-key', profile.apiKey);
    headers.set('anthropic-version', '2023-06-01');
    body = { model: profile.model, ...(system ? { system } : {}), messages, max_tokens: maxTokens,
      ...(schema ? { output_config: { format: { type: 'json_schema', schema: schema.schema } } } : {}),
    };
    if (effort && profile.compatibility?.forceAdaptiveThinking) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { ...(body.output_config as object || {}), effort: effort === 'minimal' ? 'low' : effort };
    } else if (effort && profile.compatibility?.thinkingBudgetTokens) {
      body.thinking = { type: 'enabled', budget_tokens: profile.compatibility.thinkingBudgetTokens };
    }
  } else if (profile.protocol === 'openai-responses') {
    path = '/responses';
    headers.set('Authorization', `Bearer ${profile.apiKey}`);
    body = { model: profile.model, ...(system ? { instructions: system } : {}), input: messages,
      max_output_tokens: maxTokens, store: false,
      ...(effort ? { reasoning: { effort } } : {}),
      ...(schema ? { text: { format: { type: 'json_schema', name: schema.name, strict: true, schema: schema.schema } } } : {}),
    };
  } else {
    path = '/chat/completions';
    headers.set('Authorization', `Bearer ${profile.apiKey}`);
    body = { model: profile.model, messages: options.messages, max_tokens: maxTokens,
      ...(effort && profile.supportedParameters.includes('reasoning') ? { reasoning: { effort } } : {}),
      ...(effort && !profile.supportedParameters.includes('reasoning') && profile.supportedParameters.includes('reasoning_effort') ? { reasoning_effort: effort } : {}),
      ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } } } : {}),
    };
  }
  const response = await fetch(`${profile.baseUrl}${path}`, {
    method: 'POST', headers, body: JSON.stringify(channelRequestBody(profile, body)),
    signal: AbortSignal.timeout(options.timeoutMs ?? 240_000),
  });
  const text = await response.text();
  // Never include a credential if an upstream service echoes it in an error.
  const safe = (value: string) => profile.apiKey ? value.replaceAll(profile.apiKey, '[redacted]') : value;
  if (!response.ok) throw new ModelHttpError(response.status, safe(text));
  let result: any;
  try { result = JSON.parse(text); } catch { throw new Error('Model returned non-JSON'); }
  if (result.error) throw new ModelHttpError(502, safe(JSON.stringify(result.error)));
  let content = '';
  let finishReason = '';
  let annotations: any[] = [];
  if (profile.protocol === 'anthropic-messages') {
    content = (result.content || []).filter((block: any) => block.type === 'text').map((block: any) => block.text || '').join('');
    finishReason = result.stop_reason === 'max_tokens' ? 'length' : result.stop_reason === 'end_turn' ? 'stop' : String(result.stop_reason || '');
  } else if (profile.protocol === 'openai-responses') {
    const blocks = (result.output || []).filter((item: any) => item.type === 'message').flatMap((item: any) => item.content || []);
    content = blocks.filter((block: any) => block.type === 'output_text').map((block: any) => block.text || '').join('');
    annotations = blocks.flatMap((block: any) => block.annotations || []);
    finishReason = result.incomplete_details?.reason === 'max_output_tokens' ? 'length' : result.status === 'completed' ? 'stop' : String(result.status || '');
  } else {
    const choice = result.choices?.[0];
    content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    finishReason = String(choice?.finish_reason || '');
    annotations = choice?.message?.annotations || [];
  }
  const finiteCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  return { content, finishReason, provider: profile.provider, model: String(result.model || profile.model),
    requestId: String(result.id || '').slice(0, 200),
    inputTokens: finiteCount(result.usage?.prompt_tokens ?? result.usage?.input_tokens),
    outputTokens: finiteCount(result.usage?.completion_tokens ?? result.usage?.output_tokens),
    costUsd: finiteCount(result.usage?.cost),
    citations: annotations.filter(annotation => annotation.type === 'url_citation').map(annotation => {
      const citation = annotation.url_citation || annotation;
      return { url: String(citation.url || ''), title: String(citation.title || ''), content: String(citation.content || '') };
    }).filter(citation => citation.url),
  };
}
