import { requestModelText } from './model-request';
import type { ResolvedModelProfile } from '../agent-runtime/model-registry';
export { ModelHttpError } from './model-request';

function unwrapStructuredJson(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

export type UrlCitation = {
  url: string;
  title: string;
  content: string;
  query?: string;
};

export class ModelResponseError extends Error {
  modelCallMeta: ModelUsageMeta & { finishReason: string; code: string };

  constructor(code: string, message: string, meta: ModelUsageMeta & { finishReason: string }) {
    super(`${message} (${JSON.stringify({
      code,
      request_id: meta.requestId,
      provider: meta.provider,
      model: meta.model,
      finish_reason: meta.finishReason,
      input_tokens: meta.inputTokens,
      output_tokens: meta.outputTokens,
    })})`);
    this.name = 'ModelResponseError';
    this.modelCallMeta = { ...meta, finishReason: meta.finishReason, code };
  }
}

type CompleteJsonOptions = {
  profile: ResolvedModelProfile;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxCompletionTokens?: number;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  timeoutMs?: number;
  onUsage?: (usage: ModelUsageMeta) => void | Promise<void>;
};

export type ModelUsageMeta = {
  provider: string;
  model: string;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export async function completeJson<T>(opts: CompleteJsonOptions): Promise<T> {
  return (await completeJsonWithMeta<T>(opts)).data;
}

export async function completeJsonWithMeta<T>(opts: CompleteJsonOptions): Promise<{ data: T; citations: UrlCitation[] }> {
  const result = await requestModelText(opts.profile, {
    messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }],
    jsonSchema: { name: opts.schemaName, schema: opts.schema },
    maxTokens: opts.maxCompletionTokens, reasoningEffort: opts.reasoningEffort, timeoutMs: opts.timeoutMs,
  });
  const { content, citations, finishReason, ...usageMeta } = result;
  const meta = { ...usageMeta, finishReason };
  await opts.onUsage?.(usageMeta);
  if (!content) throw new ModelResponseError('missing_content', 'Model response missing content', meta);
  try {
    return { data: JSON.parse(unwrapStructuredJson(content)) as T, citations };
  } catch {
    throw new ModelResponseError('invalid_json', 'Model response content is not valid JSON', meta);
  }
}
