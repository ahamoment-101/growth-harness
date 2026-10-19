import { expect, it } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { taskTestDb } from './task-test-db';
import { attachTask } from './task-store';
import { agentDefinition } from './definitions';
import { appendConversationMessage, conversationResumePoint, initializeConversation, readConversation } from './conversation-store';
import { estimateTextTokens, requestCapacity } from './request-capacity';
import { semanticMessage } from './message-view';
import { measuredAssistant, calibratedRequestCapacity } from './request-calibration';
import { readModelConversation } from './conversation-read';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';

async function fixture() {
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  await initializeConversation(f.db, task, 'Preserve evidence', {});
  return { ...f, task };
}

it('reads more than 256 small messages without forcing a compaction or losing the latest input', async () => {
  const f = await fixture();
  for (let n = 0; n < 300; n++) await appendConversationMessage(f.db, f.task, `input:${n}`, { role: 'user', content: `Observation ${n}`, timestamp: n });
  const snapshot = (await readConversation(f.db, f.task, { maxReadTokens: 128000 }))!;
  expect(snapshot.messages).toHaveLength(300);
  expect(snapshot.messages.at(-1)?.message.content).toBe('Observation 299');
  expect(snapshot.hasMore).toBe(false);
  expect(snapshot.compaction).toBeNull();
  expect(requestCapacity({ systemPrompt: snapshot.instructions, messages: snapshot.messages.map(row => row.message) }, 128000, 32000).fits).toBe(true);
});

it('finishes a tool batch across database pages before cutting at the next message', async () => {
  const f = await fixture();
  let tokens = 0;
  for (let n = 0; n < 63; n++) {
    const message: Message = { role: 'user', content: `Observation ${n}`, timestamp: n };
    tokens += estimateTextTokens(JSON.stringify(semanticMessage(message))) + 8;
    await appendConversationMessage(f.db, f.task, `input:${n}`, message);
  }
  const assistant = { role: 'assistant', content: ['a', 'b'].map(id => ({ type: 'toolCall', id, name: 'read', arguments: {} })), stopReason: 'toolUse', timestamp: 64 } as Message;
  tokens += estimateTextTokens(JSON.stringify(semanticMessage(assistant))) + 8;
  await appendConversationMessage(f.db, f.task, 'response:64', assistant);
  for (const id of ['a', 'b']) await appendConversationMessage(f.db, f.task, `tool:${id}`, {
    role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: `result ${id}` }], isError: false, timestamp: 65,
  });
  await appendConversationMessage(f.db, f.task, 'next', { role: 'user', content: 'Next observation', timestamp: 67 });
  const page = (await readConversation(f.db, f.task, { maxReadTokens: tokens }))!;
  expect(page.messages).toHaveLength(66);
  expect(page.calls.every(call => call.result_sequence !== null)).toBe(true);
  expect(page.hasMore).toBe(true);
  const complete = (await readConversation(f.db, f.task, { maxReadTokens: 128000 }))!;
  expect(complete.messages.at(-1)?.key).toBe('next');
  expect(complete.hasMore).toBe(false);
});

it('bounds a large history by semantic capacity while retaining the entire original archive', async () => {
  const f = await fixture();
  for (let n = 0; n < 20; n++) await appendConversationMessage(f.db, f.task, `large:${n}`, { role: 'user', content: 'materials'.repeat(2000), timestamp: n });
  const page = (await readConversation(f.db, f.task, { maxReadTokens: 10000 }))!;
  expect(page.messages.length).toBeLessThan(20);
  expect(page.hasMore).toBe(true);
  expect(requestCapacity({ messages: page.messages.map(row => row.message) }, 10000, 1000).fits).toBe(false);
  expect((await readConversation(f.db, f.task, { archive: true }))!.messages).toHaveLength(20);
});

it('counts failed response feedback instead of discarded partial output when reading subsequent input', async () => {
  const f = await fixture();
  await appendConversationMessage(f.db, f.task, 'failed', { role: 'assistant', content: [{ type: 'text', text: 'unfinished'.repeat(20000) }],
    stopReason: 'error', errorMessage: 'Connection interrupted', timestamp: 0 } as Message);
  await appendConversationMessage(f.db, f.task, 'new-input', { role: 'user', content: 'Use the confirmed evidence', timestamp: 1 });
  const snapshot = (await readConversation(f.db, f.task, { maxReadTokens: 1000 }))!;
  expect(snapshot.hasMore).toBe(false);
  const point = conversationResumePoint(snapshot);
  expect(JSON.stringify(point.messages)).toContain('Connection interrupted');
  expect(JSON.stringify(point.messages)).toContain('Use the confirmed evidence');
  expect(JSON.stringify(point.messages)).not.toContain('unfinished');
  expect(requestCapacity({ messages: point.messages }, 1000, 100).fits).toBe(true);
  expect(JSON.stringify((await readConversation(f.db, f.task, { archive: true }))!.messages)).toContain('unfinished');
});

it('continues at the same storage cursor when measured capacity fits history beyond the estimated read boundary', async () => {
  const f = await fixture();
  const model = { provider: 'test', id: 'test', baseUrl: 'https://example.invalid', contextWindow: 10000, maxTokens: 1000 } as Model<'openai-completions'>;
  const first: Message = { role: 'user', timestamp: 0, content: 'Evidence '.repeat(2500) };
  await appendConversationMessage(f.db, f.task, 'first', first);
  const response = await measuredAssistant({ role: 'assistant', api: 'openai-completions', provider: 'test', model: 'test',
    timestamp: 1, content: [{ type: 'text', text: 'Recorded evidence' }], stopReason: 'stop',
    usage: { input: 450, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 460,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as AssistantMessage, { systemPrompt: 'Preserve evidence', messages: [first] }, model);
  await appendConversationMessage(f.db, f.task, 'response', response);
  await appendConversationMessage(f.db, f.task, 'large', { role: 'user', timestamp: 2, content: 'x'.repeat(9000) });
  await appendConversationMessage(f.db, f.task, 'latest', { role: 'user', timestamp: 3, content: 'The latest confirmed entity is entity-7 version 2' });
  const estimated = (await readConversation(f.db, f.task, { maxReadTokens: model.contextWindow }))!;
  expect(estimated.hasMore).toBe(true);
  const complete = (await readModelConversation(f.db, f.task, model, undefined))!;
  expect(complete.messages).toHaveLength(4);
  expect(complete.messages.at(-1)?.key).toBe('latest');
  expect(complete.hasMore).toBe(false);
  expect(complete.compaction).toBeNull();
  expect((await calibratedRequestCapacity({ systemPrompt: complete.instructions, messages: conversationResumePoint(complete).messages }, model)).fits).toBe(true);
  await appendConversationMessage(f.db, f.task, 'overflow', { role: 'user', timestamp: 4, content: 'y'.repeat(30000) });
  await appendConversationMessage(f.db, f.task, 'unread', { role: 'user', timestamp: 5, content: 'Retain this in the archive until maintenance' });
  const bounded = (await readModelConversation(f.db, f.task, model, undefined))!;
  expect(bounded.hasMore).toBe(true);
  expect(bounded.messages.at(-1)?.key).toBe('overflow');
  expect((await calibratedRequestCapacity({ systemPrompt: bounded.instructions, messages: conversationResumePoint(bounded).messages }, model)).fits).toBe(false);
});
