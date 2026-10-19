import { describe, expect, it } from 'vitest';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { runAgentLoopContinue } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { conversationTool } from './conversation-tools';
import { replayConversationResponse } from './conversation-replay';
import { taskTestDb, resumeTestTask } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, finishTaskOperation, finishTaskTerminal, requireTask, stopTask, writeTaskWorkspace } from './task-store';
import { appendConversationMessage, bindConversationOperation, conversationResumePoint, initializeConversation, readConversation, taskDecisionTurns } from './conversation-store';

const definition = agentDefinition('strategy_research');
function assistant(ids = ['a', 'b']): AssistantMessage {
  return { role: 'assistant', content: ids.map(id => ({ type: 'toolCall', id, name: 'save_fact', arguments: { value: id } })),
    api: 'openai-completions', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const result = (id: string, text = 'saved'): ToolResultMessage => ({ role: 'toolResult', toolCallId: id, toolName: 'save_fact',
  content: [{ type: 'text', text }], isError: false, timestamp: 2 });
async function fixture() {
  const state = taskTestDb();
  const task = await attachTask(state.db, state.run(), definition);
  await initializeConversation(state.db, task, 'Research role', { business_version: 3 });
  await appendConversationMessage(state.db, task, 'trigger', { role: 'user', content: 'Start research', timestamp: 0 });
  await appendConversationMessage(state.db, task, 'response-1', assistant());
  return { ...state, task };
}

describe('durable native conversation', () => {
  it('keeps a tool receipt once while preserving the model result and replay identity', async () => {
    const { db, task } = await fixture();
    const operation = await bindConversationOperation(db, task, 'a', {});
    const output = { saved: 'entity-1', version: 3, evidence: 'evidence'.repeat(20000) };
    await finishTaskOperation(db, task, operation, output);
    const message = { ...result('a', JSON.stringify(output)), details: output };
    const sequence = await appendConversationMessage(db, task, 'result-a', message);
    expect(await appendConversationMessage(db, task, 'result-a', { ...message, timestamp: 7 })).toBe(sequence);
    const snapshot = (await readConversation(db, task))!;
    const saved = snapshot.messages.find(row => row.key === 'result-a')!.message;
    expect(saved).not.toHaveProperty('details');
    expect(saved.content).toEqual(message.content);
    const receipt = await db.prepare('select output_json from agent_task_operations where id=?').bind(operation.id).first<{output_json:string}>();
    const { readRuntimeJson } = await import('./runtime-content');
    expect(await readRuntimeJson(db, receipt!.output_json)).toEqual(output);
    await expect(appendConversationMessage(db, task, 'result-a', result('a', 'different result'))).rejects.toThrow('different content');
  });
  it('counts one multi-tool decision independently of operation and descendant usage counters', async () => {
    const { db, task } = await fixture();
    await appendConversationMessage(db, task, 'result-a', result('a'));
    await appendConversationMessage(db, task, 'result-b', result('b'));
    const current = { ...await requireTask(db, task.active_run_id), next_turn: 3, model_calls: 9 };
    expect(await taskDecisionTurns(db, current)).toBe(1);
    expect(await taskDecisionTurns(db, { ...current, conversation_version: 0 })).toBe(2);
    expect(await taskDecisionTurns(db, { ...current, workspace_id: 'another' })).toBe(0);
  });

  it('preserves initial context and reads the exact saved pending response', async () => {
    const { db, task } = await fixture();
    await initializeConversation(db, task, 'Changed role', { business_version: 99 });
    const snapshot = (await readConversation(db, task, { initial: true }))!;
    expect(snapshot.context).toEqual({ business_version: 3 });
    expect(snapshot.instructions).toBe('Research role');
    expect(conversationResumePoint(snapshot)).toEqual({ messages: [{ role: 'user', content: 'Start research', timestamp: 0 }], pending: assistant(), pendingKey: 'response-1' });
  });

  it('initializes context and working state together, and never reinitializes saved work', async () => {
    const f = taskTestDb();
    const task = await attachTask(f.db, f.run(), definition);
    await initializeConversation(f.db, task, 'Role', { version: 1 }, { inherited: 'Original' });
    expect(JSON.parse((await requireTask(f.db, task.active_run_id)).workspace_json)).toEqual({ inherited: 'Original' });
    await initializeConversation(f.db, task, 'Other role', { version: 2 }, { inherited: 'Replacement' });
    expect(JSON.parse((await requireTask(f.db, task.active_run_id)).workspace_json)).toEqual({ inherited: 'Original' });
    expect((await readConversation(f.db, task, { initial: true }))?.context).toEqual({ version: 1 });
  });

  it('rejects stale bootstrap state without recording a mismatched initial context', async () => {
    const f = taskTestDb();
    const task = await attachTask(f.db, f.run(), definition);
    await f.db.prepare('update agent_tasks set revision=1,workspace_json=? where id=?').bind('{"kept":true}', task.id).run();
    await expect(initializeConversation(f.db, task, 'Role', { version: 1 }, { replacement: true })).rejects.toThrow('initialization');
    expect(await readConversation(f.db, task, { initial: true })).toBeNull();
    expect(JSON.parse((await requireTask(f.db, task.active_run_id)).workspace_json)).toEqual({ kept: true });
  });

  it('recovers a committed domain effect before its tool result was appended without overwriting later work', async () => {
    const { db, task } = await fixture();
    const first = await bindConversationOperation(db, task, 'a', { original: true });
    await writeTaskWorkspace(db, task, first, 0, { value: 'first committed' });
    await finishTaskOperation(db, task, first, { revision: 1 });
    await stopTask(db, task.active_run_id, 'paused', 'crash before message append');
    const resumed = await resumeTestTask(db, task.active_run_id);
    const receipt = await bindConversationOperation(db, resumed, 'a', { must_not_replace: true });
    expect(receipt).toMatchObject({ id: first.id, status: 'succeeded', context_json: '{"original":true}', output_json: '{"revision":1}' });
    await appendConversationMessage(db, resumed, 'result-a', result('a'));
    const second = await bindConversationOperation(db, await requireTask(db, resumed.active_run_id), 'b', {});
    await writeTaskWorkspace(db, resumed, second, 1, { value: 'second committed' });
    await finishTaskOperation(db, resumed, second, { revision: 2 });
    await appendConversationMessage(db, resumed, 'result-b', result('b'));
    await writeTaskWorkspace(db, resumed, receipt, 0, { value: 'stale replay' });
    expect(JSON.parse((await requireTask(db, resumed.active_run_id)).workspace_json)).toEqual({ value: 'second committed' });
    const snapshot = (await readConversation(db, resumed))!;
    expect(conversationResumePoint(snapshot).pending).toBeNull();
    expect(snapshot.calls.map(c => c.operation_id)).toEqual([`${task.id}:1`, `${task.id}:2`]);
    expect(snapshot.messages.map(m => m.message.role)).toEqual(['user', 'assistant', 'toolResult', 'toolResult']);
  });

  it('deduplicates replay timestamps but rejects a changed result under the same identity', async () => {
    const { db, task } = await fixture();
    await appendConversationMessage(db, task, 'result-a', result('a'));
    expect(await appendConversationMessage(db, task, 'result-a', { ...result('a'), timestamp: 999 })).toBe(3);
    await expect(appendConversationMessage(db, task, 'result-a', result('a', 'different'))).rejects.toThrow('different content');
    expect((await readConversation(db, task, { initial: true }))!.messages).toHaveLength(3);
  });

  it('enforces call correlation and sequential effects while preserving failed observations', async () => {
    const { db, task } = await fixture();
    await expect(bindConversationOperation(db, task, 'b', {})).rejects.toThrow('preceding');
    await expect(appendConversationMessage(db, task, 'result-b', result('b'))).rejects.toThrow('assistant order');
    await expect(appendConversationMessage(db, task, 'unknown', result('unknown'))).rejects.toThrow('does not match');
    await expect(appendConversationMessage(db, task, 'wrong-tool', { ...result('a'), toolName: 'different_tool' })).rejects.toThrow('does not match');
    await expect(appendConversationMessage(db, task, 'too-soon', assistant(['c']))).rejects.toThrow('assistant order');
    await appendConversationMessage(db, task, 'failed-a', { ...result('a', 'invalid input'), isError: true });
    expect((await bindConversationOperation(db, task, 'b', {})).turn).toBe(1);
  });

  it('rejects duplicate call IDs atomically without leaving a partial response', async () => {
    const { db, task } = await fixture();
    await appendConversationMessage(db, task, 'result-a', result('a'));
    await appendConversationMessage(db, task, 'result-b', result('b'));
    await expect(appendConversationMessage(db, task, 'reused-id', assistant(['c', 'a']))).rejects.toThrow();
    const snapshot = (await readConversation(db, task, { initial: true }))!;
    expect(snapshot.messages).toHaveLength(4);
    expect(snapshot.calls.map(c => c.call_id)).toEqual(['a', 'b']);
  });

  it('fences old executions and cancellation while allowing terminal receipt readback', async () => {
    const { db, task } = await fixture();
    await stopTask(db, task.active_run_id, 'paused', 'interrupted');
    const resumed = await resumeTestTask(db, task.active_run_id);
    await expect(appendConversationMessage(db, task, 'stale-result', result('a'))).rejects.toThrow('gate');
    await expect(bindConversationOperation(db, task, 'a', {})).rejects.toThrow('ownership');
    await stopTask(db, resumed.active_run_id, 'cancelled', 'user cancelled');
    await expect(appendConversationMessage(db, resumed, 'cancelled-result', result('a'))).rejects.toThrow('gate');
    expect((await readConversation(db, resumed))!.messages).toHaveLength(2);
  });

  it('can close saved calls after atomic domain completion without permitting new assistant work', async () => {
    const { db, task } = await fixture();
    const operation = await bindConversationOperation(db, task, 'a', {});
    await finishTaskTerminal(db, task, operation, { status: 'completed', outcome: 'no_change', reason: 'Current facts suffice', output: { unchanged: true } });
    await appendConversationMessage(db, task, 'result-a', result('a'));
    await appendConversationMessage(db, task, 'result-b', { ...result('b', 'Task completed; not executed'), isError: true });
    await expect(appendConversationMessage(db, task, 'late-response', assistant(['c']))).rejects.toThrow('gate');
    expect(conversationResumePoint((await readConversation(db, task, { initial: true }))!).pending).toBeNull();
  });

  it('resumes a partial multi-call batch through Pi without generating another decision or repeating effects', async () => {
    const { db, task } = await fixture();
    const first = await bindConversationOperation(db, task, 'a', {});
    await writeTaskWorkspace(db, task, first, 0, { value: 'a' });
    await finishTaskOperation(db, task, first, { revision: 1 });
    await stopTask(db, task.active_run_id, 'paused', 'crash before tool result persistence');
    const resumed = await resumeTestTask(db, task.active_run_id);
    const point = conversationResumePoint((await readConversation(db, resumed))!);
    const effects: string[] = [];
    let modelCalls = 0;
    const tool = conversationTool({ name: 'save_fact', description: 'Save a fact', inputSchema: z.object({ value: z.string() }) }, async (id, args) => {
      const current = await requireTask(db, resumed.active_run_id);
      const operation = await bindConversationOperation(db, current, id, {});
      let output: unknown;
      if (operation.status === 'succeeded') output = JSON.parse(operation.output_json);
      else {
        effects.push(id);
        output = await writeTaskWorkspace(db, current, operation, current.revision, args);
        await finishTaskOperation(db, current, operation, output);
      }
      return { content: [{ type: 'text', text: JSON.stringify(output) }], details: output };
    });
    await runAgentLoopContinue({ systemPrompt: 'Research role', messages: point.messages, tools: [tool] }, {
      model: { id: 'test', name: 'test', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid',
        reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      convertToLlm: messages => messages.filter((m): m is AssistantMessage | ToolResultMessage | Extract<typeof m, { role: 'user' }> => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'),
      toolExecution: 'sequential', shouldStopAfterTurn: () => true,
    }, async event => {
      if (event.type !== 'message_end') return;
      if (event.message.role === 'assistant') await appendConversationMessage(db, resumed, point.pendingKey!, event.message);
      if (event.message.role === 'toolResult') await appendConversationMessage(db, resumed, `tool:${event.message.toolCallId}`, event.message);
    }, undefined, replayConversationResponse(point.pending!, () => { modelCalls++; throw new Error('Must not regenerate saved decision'); }));
    expect(modelCalls).toBe(0);
    expect(effects).toEqual(['b']);
    expect((await requireTask(db, resumed.active_run_id)).revision).toBe(2);
    expect(conversationResumePoint((await readConversation(db, resumed))!).pending).toBeNull();
  });
});

it('atomically projects only explicitly public complete assistant text, with idempotent replay', async () => {
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), definition);
  await initializeConversation(f.db, task, 'public role', {});
  const message: AssistantMessage = { ...assistant([]), stopReason: 'stop', content: [
    { type: 'thinking', thinking: 'PRIVATE REASONING' }, { type: 'text', text: 'Verifying materials and confirming the coverage of existing content.' },
  ] };
  await appendConversationMessage(f.db, task, 'public', message, 'normal', true);
  await appendConversationMessage(f.db, task, 'public', message, 'normal', true);
  await appendConversationMessage(f.db, task, 'old', { ...message, content: [{ type: 'text', text: 'Legacy text' }] });
  await appendConversationMessage(f.db, task, 'partial', { ...message, stopReason: 'length' }, 'normal', true);
  expect(f.sqlite.prepare('select body from agent_work_notes').all()).toEqual([{ body: 'Verifying materials and confirming the coverage of existing content.' }]);
  const stale = { ...task, epoch: task.epoch - 1 };
  await expect(appendConversationMessage(f.db, stale, 'stale', message, 'normal', true)).rejects.toThrow();
  expect(f.sqlite.prepare('select count(*) as n from agent_work_notes').get()).toEqual({ n: 1 });
});
