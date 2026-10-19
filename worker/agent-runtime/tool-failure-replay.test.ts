import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { taskTestDb } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, taskForRun, taskResumeBlocker } from './task-store';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { ToolRegistry } from './tools';
import { runConversationTask, type ConversationAgent } from './conversation-runtime';
import { replayConversationResponse } from './conversation-replay';
import { ToolExecutionError } from './tool-failure';

const model: Model<'openai-completions'> = { id: 'test', name: 'test', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid',
  reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const reply = (calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): AssistantMessage => ({ role: 'assistant', content: calls.map(c => ({ type: 'toolCall', ...c })),
  api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 1,
  usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const step = { do: async (_k: string, c: unknown, fn?: () => Promise<unknown>) => (fn || c as () => Promise<unknown>)(), sleep: async () => {}, waitForEvent: async () => ({ payload: {} }) } as unknown as RuntimeWorkflowStep;

async function run(error: () => Error, replaySafety: 'idempotent' | 'unreconciled' = 'idempotent') {
  const state = taskTestDb();
  const definition = { ...agentDefinition('strategy_research'), stagePolicy: undefined, tools: ['delegate', 'finish'] };
  const task = await attachTask(state.db, state.run(), definition);
  const seen: string[] = [];
  const agent: ConversationAgent = { instructions: 'x', context: async () => ({}), completionInstructions: 'x',
    tools: () => new ToolRegistry()
      .register({ name: 'delegate', version: 1, description: 'Idempotent delegation', capability: 'external', replaySafety, timeoutMs: 1000, retryable: false, approval: 'never',
        inputSchema: z.object({}), outputSchema: z.unknown(), execute: async () => { throw error(); } })
      .register({ name: 'finish', version: 1, description: 'Finish', capability: 'write', replaySafety: 'idempotent', timeoutMs: 1000, retryable: false, approval: 'never',
        inputSchema: z.object({ reason: z.string() }), outputSchema: z.unknown(), execute: async i => i,
        completion: o => ({ status: 'completed', outcome: 'done', reason: 'handled', output: o }) }) };
  const responses = [reply([{ id: 'd', name: 'delegate', arguments: {} }]), reply([{ id: 'f', name: 'finish', arguments: { reason: 'handled failure' } }])];
  const stream: StreamFn = (m, context, options) => { seen.push(JSON.stringify(context.messages.at(-1))); const r = responses.shift(); if (!r) throw new Error('no more'); return replayConversationResponse(r, stream)(m, context, options); };
  const result = await runConversationTask({ env: { DB: state.db } as RuntimeAgentEnv, step, runId: task.active_run_id, definition, agent, transport: { model, stream } });
  const after = (await taskForRun(state.db, task.active_run_id))!;
  return { result, modelCalls: seen.length, modelSawFailure: seen.some(s => s.includes('toolResult')), block: await taskResumeBlocker(state.db, after) };
}

describe('unclassified tool failures', () => {
  it('returns a classified failure to the Agent loop', async () => {
    const r = await run(() => new ToolExecutionError('provider said no', { kind: 'transient', retryable: true, effects: 'none', guidance: 'retry' }));
    expect(r).toMatchObject({ result: { status: 'completed' }, modelCalls: 2, modelSawFailure: true, block: null });
  });
  it('returns an unclassified failure of an idempotent tool to the Agent loop', async () => {
    const r = await run(() => new Error('Child task identity mismatch'));
    expect(r).toMatchObject({ result: { status: 'completed' }, modelCalls: 2, modelSawFailure: true, block: null });
  });
  it('still withholds an unclassified failure of an unreconciled tool from replay', async () => {
    const r = await run(() => new Error('Child task identity mismatch'), 'unreconciled');
    expect(r).toMatchObject({ result: { status: 'paused', outcome: 'external_pending' }, modelCalls: 1, modelSawFailure: false, block: { kind: 'unknown_effect', tool: 'delegate' } });
  });
});
