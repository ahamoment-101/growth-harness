import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { requestConversationModel, contextOverflowResponse } from './conversation-request';
import { estimateTextTokens, requestCapacity } from './request-capacity';
import { ExecutionFailureError } from './execution-failure';

type SummaryInput = {
  env: RuntimeAgentEnv; step: RuntimeWorkflowStep; runId: string;
  key: string; turn: number; instructions: string; material: string;
  model: Model<Api>; stream: StreamFn;
};

/** Reduce only while the final caller's complete request is over capacity.
 * Each level is replayable; no new summary is installed until it fits. */
export async function fitDurableSummary(input: SummaryInput & {
  fits: (summary: string) => boolean;
  targetTokens: number;
}): Promise<string> {
  let summary = input.material;
  let feedback = '';
  for (let level = 0; !input.fits(summary); level++) {
    const previousSize = estimateTextTokens(summary);
    const reduced = await summarizeDurably({ ...input, key: `${input.key}:reduce:${level}`, material: summary,
      instructions: `${input.instructions}\nThe combined summary exceeds the destination request capacity. Consolidate redundant statements, preserving entities, effects, unresolved work and references. The summary must fit within approximately ${input.targetTokens} tokens. Do not repeat the supplied material verbatim.${feedback}` });
    if (!input.fits(reduced) && estimateTextTokens(reduced) >= previousSize) {
      // Keep the accepted source and expose the measured rejection to the next
      // request. The shared execution-step limit hands off the host if needed;
      // a failed compression judgment is not a business waiting condition.
      feedback = `\nCapacity feedback after reduction ${level + 1}: source estimate ${previousSize} tokens; your rejected result estimate ${estimateTextTokens(reduced)} tokens. It still exceeds the destination capacity and did not reduce the source. The supplied source is unchanged. Choose a more concise representation rather than repeating the rejected approach. Exact original material remains archived.`;
      continue;
    }
    summary = reduced;
    feedback = '';
  }
  return summary;
}

/** Divide oversized input on serialized message or document boundaries first.
 * An indivisible document is explicitly represented as fragments, never as a
 * complete document. This is input transport, not a business summarization rule. */
export function summaryFragments(material: string): [string, string] | null {
  try {
    const messages: unknown = JSON.parse(material);
    if (Array.isArray(messages) && messages.length > 1) {
      const middle = Math.ceil(messages.length / 2);
      return [JSON.stringify(messages.slice(0, middle)), JSON.stringify(messages.slice(middle))];
    }
  } catch { /* Plain documents use paragraph boundaries. */ }
  const middle = Math.floor(material.length / 2);
  const paragraph = material.lastIndexOf('\n\n', middle);
  if (paragraph > 0) return [material.slice(0, paragraph), material.slice(paragraph)];
  const characters = Array.from(material);
  if (characters.length < 2) return null;
  const split = Math.floor(characters.length / 2);
  return [characters.slice(0, split).join(''), characters.slice(split).join('')];
}

/** Each attempt has a durable identity. Incomplete output is feedback to the
 * next maintenance decision; only input capacity authorizes splitting input. */
export async function summarizeDurably(input: SummaryInput): Promise<string> {
  let feedback = '';
  let rejectedCapacity = false;
  for (let attempt = 0; ; attempt++) {
    const context: Context = { systemPrompt: input.instructions + feedback,
      messages: [{ role: 'user', timestamp: 0, content: input.material }] };
    const capacity = requestCapacity(context, input.model.contextWindow, input.model.maxTokens);
    if (!capacity.known) throw new ExecutionFailureError({ origin: 'local_platform', scope: 'request', recovery_action: 'pause',
      message: 'Summary model capacity is unknown', status: 0, request_id: '', stage: 'context_compaction' });
    if (!capacity.fits || rejectedCapacity) {
      const fragments = summaryFragments(input.material);
      if (!fragments) throw new ExecutionFailureError({ origin: 'local_platform', scope: 'request', recovery_action: 'pause',
        message: 'Summary instructions and minimum input exceed the configured request capacity', status: 0, request_id: '', stage: 'context_compaction' });
      const instructions = `${input.instructions}\nThis request contains a fragment of the source. Preserve visible facts and exact references; do not claim to have read other fragments. All fragment results remain retained.`;
      const left = await summarizeDurably({ ...input, instructions, key: `${input.key}:left`, material: fragments[0] });
      const right = await summarizeDurably({ ...input, instructions, key: `${input.key}:right`, material: fragments[1] });
      return `${left}\n\n${right}`;
    }
    const decisionId = attempt === 0 ? input.key : `${input.key}:repair:${attempt}`;
    const response = await requestConversationModel({ ...input, decisionId, purpose: 'context_compaction',
      context, maxTokens: input.model.maxTokens, requireCompleteResponse: true, reuseTruncatedResponse: true });
    if (contextOverflowResponse(response)) { rejectedCapacity = true; continue; }
    if (['error', 'aborted'].includes(response.stopReason)) throw new ExecutionFailureError({ origin: 'upstream', scope: 'request',
      recovery_action: 'retry_request', message: response.errorMessage || 'Summary provider interrupted', status: 0,
      request_id: response.responseId || '', stage: 'context_compaction' });
    const summary = response.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
    if (response.stopReason !== 'length' && summary) return summary;
    feedback = `\nSummary attempt ${attempt + 1} did not produce a complete usable summary: stop_reason=${response.stopReason}, visible_characters=${summary.length}, reported_output_tokens=${response.usage.output}. Its receipt is ${decisionId}; it has not replaced the original material. Produce a complete, concise summary with the required entities, effects and unresolved work. Allocate generation to the summary itself. The complete source remains supplied below.`;
  }
}
