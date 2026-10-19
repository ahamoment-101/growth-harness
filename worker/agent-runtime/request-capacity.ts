import type { Context } from '@earendil-works/pi-ai';
import { capacityRequest } from './message-view';

/** An estimate, not a tokenizer. Non-ASCII code points are counted separately
 * so English text and CJK do not inherit a UTF-8 byte = token assumption. */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if (character.codePointAt(0)! < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3) + other;
}

export function requestCapacity(context: Context, contextWindow: number, maximumOutput: number) {
  const serialized = JSON.stringify(capacityRequest(context));
  // Covers role delimiters and provider request framing. This is not an early
  // compaction percentage and must be calibrated against actual request usage.
  const framingTokens = 256 + context.messages.length * 8 + (context.tools?.length || 0) * 16;
  const estimatedInputTokens = estimateTextTokens(serialized) + framingTokens;
  const known = Number.isSafeInteger(contextWindow) && contextWindow > 0 && Number.isSafeInteger(maximumOutput) && maximumOutput > 0;
  return {
    bytes: new TextEncoder().encode(serialized).length,
    estimatedInputTokens,
    measurement: 'text_estimate' as const,
    framingTokens,
    contextWindow,
    maximumOutput,
    known,
    // Reserve the declared generation allowance rather than a domain-specific cap.
    availableInputTokens: known ? Math.max(0, contextWindow - maximumOutput) : 0,
    fits: known && estimatedInputTokens + maximumOutput <= contextWindow,
    allowedOutputTokens: known ? Math.max(0, Math.min(maximumOutput, contextWindow - estimatedInputTokens)) : 0,
  };
}
