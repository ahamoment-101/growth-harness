import { expect, it } from 'vitest';
import { requestCapacity } from './request-capacity';
import { maximumGenerationTokens } from './model-registry';
import type { Message } from '@earendil-works/pi-ai';
import { semanticRequest } from './message-view';

it('counts provider replay content for capacity while keeping it out of semantic summaries', () => {
  const message = { role: 'assistant', stopReason: 'stop', content: [
    { type: 'text', text: 'Observed version 7' },
    { type: 'thinking', thinking: 'private replay content '.repeat(2000), thinkingSignature: 'reasoning_content' },
  ] } as Message;
  expect(requestCapacity({ messages: [message] }, 10000, 1000).fits).toBe(false);
  expect(JSON.stringify(semanticRequest({ messages: [message] }))).not.toContain('private replay');
});

it('counts request input without treating storage metadata as model input', () => {
  const message = { role: 'toolResult' as const, toolCallId: 'a', toolName: 'read', content: [{ type: 'text' as const, text: 'evidence' }], timestamp: 0, isError: false };
  const baseline = requestCapacity({ messages: [message] }, 128000, 32000);
  expect(requestCapacity({ messages: [{ ...message, details: 'x'.repeat(500000) } as typeof message] }, 128000, 32000)).toEqual(baseline);
  expect(baseline.fits).toBe(true);
  expect(baseline.allowedOutputTokens).toBe(32000);
  expect(baseline.estimatedInputTokens).toBeLessThan(baseline.bytes + baseline.framingTokens);
});

it('does not trigger on a page count and includes tools and identity in capacity', () => {
  const messages = Array.from({ length: 300 }, () => ({ role: 'user' as const, content: 'ok', timestamp: 0 }));
  expect(requestCapacity({ messages }, 128000, 32000).fits).toBe(true);
  expect(requestCapacity({ messages, systemPrompt: 'Constraints'.repeat(64000) }, 128000, 32000).fits).toBe(false);
});

it('reports unknown capability rather than assuming unlimited input or output', () => {
  expect(requestCapacity({ messages: [] }, 0, 0)).toMatchObject({ known: false, fits: false, allowedOutputTokens: 0 });
  expect(() => maximumGenerationTokens({ model: 'unknown', contextWindow: 0, maxOutputTokens: 0 })).toThrow('capacity is unknown');
  expect(maximumGenerationTokens({ model: 'known', contextWindow: 128000, maxOutputTokens: 32000 })).toBe(32000);
});
