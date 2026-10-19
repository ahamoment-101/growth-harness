import { expect, it } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { semanticMessage } from './message-view';

it('preserves error and exact tool correlation without duplicating durable details', () => {
  const content = [{ type: 'text' as const, text: JSON.stringify({ error: 'version conflict', observed_version: 3, artifact_ref: 'artifact-7', effects: 'none' }) }];
  const message = { role: 'toolResult', content, toolCallId: 'call-1', toolName: 'revise', isError: true,
    timestamp: 0, details: { repeated: 'large receipt'.repeat(10000) } } as Message;
  expect(semanticMessage(message)).toEqual({ role: 'toolResult', content, toolCallId: 'call-1', toolName: 'revise', isError: true });
  expect(message).toHaveProperty('details');
});

it('retains truncation as an explicit summary fact rather than presenting partial output as complete', () => {
  const call = { type: 'toolCall', id: 'partial-call', name: 'save', arguments: { reference: 'candidate-7' } };
  const message = { role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: 'Unfinished proposed change' }, call] } as Message;
  expect(semanticMessage(message)).toMatchObject({ role: 'assistant', response_status: 'incomplete', stop_reason: 'length', content: [
    { type: 'text', text: 'Unfinished proposed change' }, call,
  ] });
});

it('retains decisions and tool arguments while excluding private reasoning from summaries', () => {
  const call = { type: 'toolCall', id: 'call-2', name: 'read', arguments: { ref: 'entity-2', version: 4 } };
  const message = { role: 'assistant', content: [{ type: 'thinking', thinking: 'private test placeholder' }, call] } as Message;
  expect(semanticMessage(message)).toEqual({ role: 'assistant', content: [call] });
});
