import { readRuntimeJson } from './runtime-content';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { taskTestDb, resumeTestTask } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, taskForRun, writeTaskWorkspace, stopTask } from './task-store';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { ToolRegistry } from './tools';
import { runConversationTask, type ConversationAgent } from './conversation-runtime';
import { replayConversationResponse } from './conversation-replay';
import { ToolExecutionError } from './tool-failure';
import { readConversation, initializeConversation, appendConversationMessage } from './conversation-store';
import { calibratedRequestCapacity } from './request-calibration';
import { conversationChannel } from './conversation-channel';
import { testModelProfile } from './model-registry.test-fixture';

const model: Model<'openai-completions'> = { id: 'test', name: 'test', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid',
  reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const step = { do: async (_key: string, config: unknown, fn?: () => Promise<unknown>) => (fn || config as () => Promise<unknown>)(), sleep: async () => {}, waitForEvent: async () => ({ payload: {} }) } as unknown as RuntimeWorkflowStep;
function reply(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): AssistantMessage {
  return { role: 'assistant', content: calls.map(c => ({ type: 'toolCall', ...c })), api: model.api, provider: model.provider, model: model.id,
    stopReason: calls.length ? 'toolUse' : 'stop', timestamp: 1,
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function fixture(failFirst = false, goal = 'Find a useful fact') {
  const state = taskTestDb();
  const definition = { ...agentDefinition('strategy_research'), stagePolicy: undefined, tools: ['save_fact', 'finish'], runPolicy: {
    ...agentDefinition('strategy_research').runPolicy, maxDecisionTurns: 4, maxModelCalls: 5,
  } };
  const task = await attachTask(state.db, state.run(), definition);
  const effects: string[] = [];
  const agent: ConversationAgent = {
    instructions: 'Perform an internal research task', context: async () => ({ goal }),
    completionInstructions: 'Save useful work and explicitly finish, or explain why the task should wait.',
    tools: (current, operation) => {
      const common = { version: 1, timeoutMs: 1000, retryable: false, approval: 'never' as const, capability: 'write' as const, replaySafety: 'idempotent' as const };
      return new ToolRegistry().register({ ...common, name: 'save_fact', description: 'Save a fact', inputSchema: z.object({ value: z.string(), revision: z.number() }), outputSchema: z.object({ revision: z.number() }),
        execute: async input => { if (failFirst) { failFirst = false; throw new ToolExecutionError('Temporary domain tool failure', { kind: 'transient', retryable: true, effects: 'none', guidance: 'No write occurred; retry is safe.' }); } const result = await writeTaskWorkspace(state.db, current!, operation!, input.revision, { value: input.value }); effects.push(input.value); return result; } })
        .register({ ...common, name: 'finish', description: 'Finish without modifying the fact', inputSchema: z.object({ reason: z.string() }), outputSchema: z.object({ reason: z.string() }),
          execute: async input => input, completion: output => ({ status: 'completed', outcome: 'done', reason: output.reason, output }) });
    },
  };
  let requests = 0;
  const observations: string[] = [];
  const responses: AssistantMessage[] = [];
  const stream: StreamFn = (model, context, options) => {
    requests++;
    observations.push(JSON.stringify(context));
    const response = responses.shift();
    if (!response) throw new Error('Unexpected provider call');
    return replayConversationResponse(response, stream)(model, context, options);
  };
  const input = { env: { DB: state.db } as RuntimeAgentEnv, step, runId: task.active_run_id, definition, agent, transport: { model, stream } };
  return { ...state, input, task, effects, responses, observations, requests: () => requests };
}

describe('native conversation execution host', () => {
  it('continues a saved assistant-only tail with a durable user turn before the next model request', async () => {
    const f = await fixture();
    await initializeConversation(f.db, f.task, 'Original instructions', { goal: 'Resume the same work' });
    await appendConversationMessage(f.db, f.task, 'trigger', { role: 'user', content: 'Start', timestamp: 0 });
    await appendConversationMessage(f.db, f.task, 'response:2', {
      ...reply([]), content: [{ type: 'text', text: 'Waiting for the draft validator to be repaired.' }],
    });
    f.responses.push(reply([{ id: 'finish', name: 'finish', arguments: { reason: 'Resumed' } }]));
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
    expect(JSON.parse(f.observations[0]).messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant', 'user']);
    const history = (await readConversation(f.db, f.task))!;
    expect(history.messages.filter(message => message.key === 'continuation:2')).toHaveLength(1);
    expect(f.requests()).toBe(1);
  });

  it('uses a new physical request after an unknown predecessor outcome while preserving prior work and charges', async () => {
    const f = await fixture();
    f.responses.push(reply([{ id: 'saved', name: 'save_fact', arguments: { value: 'keep', revision: 0 } }]));
    // The following request is charged but loses its response before persistence.
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'paused' });
    const before = (await taskForRun(f.db, f.task.active_run_id))!;
    expect(before.model_calls).toBe(2);
    const resumed = await resumeTestTask(f.db, f.task.active_run_id);
    f.responses.push(reply([{ id: 'finish', name: 'finish', arguments: { reason: 'Use saved work' } }]));
    expect(await runConversationTask({ ...f.input, runId: resumed.active_run_id })).toMatchObject({ status: 'completed' });
    expect(f.effects).toEqual(['keep']);
    expect(f.requests()).toBe(3);
    expect(f.observations.at(-1)).toContain('keep');
    const current = (await taskForRun(f.db, resumed.active_run_id))!;
    expect(current.model_calls).toBe(3);
    expect(current.reserved_tokens).toBeGreaterThan(before.reserved_tokens);
    expect((await f.db.prepare("select count(*) as n from agent_task_model_reservations where outcome_state='unknown'").first<{ n: number }>())?.n).toBe(1);
  });

  it('runs multiple tools and atomically finishes with native history and cumulative usage', async () => {
    const f = await fixture();
    f.responses.push(reply([{ id: 'a', name: 'save_fact', arguments: { value: 'first', revision: 0 } },
      { id: 'b', name: 'save_fact', arguments: { value: 'second', revision: 1 } }]),
      reply([{ id: 'finish', name: 'finish', arguments: { reason: 'Enough evidence' } }, { id: 'late', name: 'save_fact', arguments: { value: 'must not write', revision: 2 } }]));
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed', outcome: 'done' });
    expect(f.effects).toEqual(['first', 'second']);
    const current = (await taskForRun(f.db, f.task.active_run_id))!;
    expect(current).toMatchObject({ revision: 2, model_calls: 2, reserved_tokens: 40 });
    const history = (await readConversation(f.db, current))!;
    expect(history.messages.map(m => m.message.role)).toEqual(['user', 'assistant', 'toolResult', 'toolResult', 'assistant', 'toolResult', 'toolResult']);
    expect(history.messages.at(-1)?.message).toMatchObject({ toolCallId: 'late', isError: true });
    const secondRequest = JSON.parse(f.observations[1]);
    expect(secondRequest.messages.find((message: { role: string }) => message.role === 'assistant')).toHaveProperty('runtimeCapacity');
    expect((await calibratedRequestCapacity(secondRequest, model)).measurement).toBe('provider_usage_plus_delta');
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
    expect(f.requests()).toBe(2);
  });

  it('repairs invalid tool input through the SDK while preserving the earlier successful effect', async () => {
    const f = await fixture();
    f.responses.push(reply([{ id: 'a', name: 'save_fact', arguments: { value: 'saved', revision: 0 } },
      { id: 'invalid', name: 'save_fact', arguments: { value: null, revision: 1 } }]),
      reply([{ id: 'fixed', name: 'save_fact', arguments: { value: 'corrected', revision: 1 } }]),
      reply([{ id: 'finish', name: 'finish', arguments: { reason: 'Done' } }]));
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
    expect(f.effects).toEqual(['saved', 'corrected']);
    const history = (await readConversation(f.db, (await taskForRun(f.db, f.task.active_run_id))!))!;
    expect(history.messages.find(m => m.key === 'tool:invalid')?.message).toMatchObject({ isError: true });
  });

  it('can retry the same valid arguments after observing a failed tool execution', async () => {
    const f = await fixture(true);
    f.responses.push(reply([{ id: 'failed', name: 'save_fact', arguments: { value: 'saved', revision: 0 } }]),
      reply([{ id: 'retried', name: 'save_fact', arguments: { value: 'saved', revision: 0 } }]),
      reply([{ id: 'finished', name: 'finish', arguments: { reason: 'Done' } }]));
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
    const history = (await readConversation(f.db, f.task))!;
    expect(history.messages.find(row => row.key === 'tool:failed')?.message).toMatchObject({ isError: true });
    expect(history.messages.find(row => row.key === 'tool:retried')?.message).toMatchObject({ isError: false });
    expect(f.effects).toEqual(['saved']);
  });

  it('semantically compacts large material and reads its original archive through a scoped tool', async () => {
    const f = await fixture(false, 'Known original detail. ' + 'archive material '.repeat(6000));
    const normal = f.input.transport.stream;
    f.input.transport.stream = (model, context, options) => !context.tools?.length
      ? replayConversationResponse({ ...reply([]), content: [{type:'text',text:'Goal: Known original detail. Research remains unfinished. Original evidence is archive sequence 1.'}] }, normal)(model,context,options)
      : normal(model,context,options);
    f.responses.push(reply([{id:'read',name:'read_conversation',arguments:{sequence:1}}]),reply([{id:'finish',name:'finish',arguments:{reason:'Read original material'}}]));
    expect(await runConversationTask(f.input)).toMatchObject({status:'completed'});
    expect(f.observations[0]).toContain('Persistent context summary');
    expect(f.observations[1]).toContain('Known original detail');
    const active = (await readConversation(f.db,f.task))!;
    expect(active.compaction?.throughSequence).toBe(1);
    const archive = (await readConversation(f.db,f.task,{archive:true}))!;
    expect(JSON.stringify(archive.messages[0].message).length).toBeGreaterThan(90000);
    const saved = await f.db.prepare('select request_json from agent_task_model_reservations').all<{request_json:string}>();
    expect((await Promise.all(saved.results.map(row=>readRuntimeJson(f.db,row.request_json)))).some(value=>JSON.stringify(value).includes('previousWorkingSummary'))).toBe(true);
  });

  it('reports unknown provider capacity before issuing a model request', async () => {
    const f = await fixture();
    f.input.transport.model = { ...f.input.transport.model, contextWindow: 0 };
    f.responses.push(reply([{ id: 'finish', name: 'finish', arguments: { reason: 'Finished with an unknown provider capacity' } }]));
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'paused', reason: expect.stringContaining('input window is unknown') });
    expect(f.requests()).toBe(0);
  });

  it('allows text-only reasoning past the retired per-run decision limit and requires explicit completion', async () => {
    const f = await fixture();
    f.responses.push(...Array.from({length:6},()=>reply([])),reply([{id:'done',name:'finish',arguments:{reason:'Task is complete'}}]));
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
    expect(f.requests()).toBe(7);
    expect(f.effects).toEqual([]);
  });

  it('lets the model repair a draft revision conflict without losing successful changes', async () => {
    const f = await fixture();
    f.responses.push(reply([{ id: 'a', name: 'save_fact', arguments: { value: 'first', revision: 0 } },
      { id: 'conflict', name: 'save_fact', arguments: { value: 'stale', revision: 0 } }]),
      reply([{ id: 'fixed', name: 'save_fact', arguments: { value: 'revised', revision: 1 } }]),
      reply([{ id: 'finish', name: 'finish', arguments: { reason: 'Done' } }]));
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
    expect(f.effects).toEqual(['first', 'revised']);
    const message = (await readConversation(f.db, f.task))!.messages.find(m => m.key === 'tool:conflict')?.message;
    expect(message).toMatchObject({ isError: true });
    expect(JSON.stringify(message)).toContain('state_conflict');
    expect(JSON.stringify(message)).toContain('current revision is 1');
  });

  it('delivers a saved final-budget tool receipt after a crash without repeating its effect', async () => {
    const f = await fixture();
    const original = f.db.prepare.bind(f.db);
    let fail = true;
    f.db.prepare = ((sql: string) => {
      if (fail && f.effects.length && sql.includes('insert into agent_conversation_messages')) {
        fail = false;
        throw new Error('Result persistence interrupted after committed effect');
      }
      return original(sql);
    }) as typeof f.db.prepare;
    f.responses.push(reply([{ id: 'saved', name: 'save_fact', arguments: { value: 'durable', revision: 0 } }]));
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'paused' });
    const resumed = await resumeTestTask(f.db, f.task.active_run_id);
    f.responses.push(reply([{ id: 'later', name: 'save_fact', arguments: { value: 'continued', revision: 1 } }]),reply([{id:'done',name:'finish',arguments:{reason:'Done'}}]));
    expect(await runConversationTask({ ...f.input, runId: resumed.active_run_id })).toMatchObject({ status: 'completed' });
    const history = (await readConversation(f.db, resumed))!;
    const saved = history.messages.find(m => m.key === 'tool:saved')!.message;
    expect(saved).toMatchObject({ isError: false });
    expect(saved).not.toHaveProperty('details');
    expect(JSON.parse((saved.content as Array<{text:string}>)[0].text)).toMatchObject({ revision: 1 });
    expect(f.effects).toEqual(['durable','continued']);
  });

  it('resumes a saved model response after message persistence fails without paying for another generation', async () => {
    const f = await fixture();
    await f.db.prepare('update agent_tasks set max_model_calls = 1 where id = ?').bind(f.task.id).run();
    const original = f.db.prepare.bind(f.db);
    let fail = true;
    f.db.prepare = ((sql: string) => {
      if (fail && sql.includes('insert into agent_conversation_messages')) {
        // Trigger is also a user message; fail only after a model request has completed.
        if (f.requests() > 0) { fail = false; throw new Error('Storage interrupted after model receipt'); }
      }
      return original(sql);
    }) as typeof f.db.prepare;
    f.responses.push(reply([{ id: 'finish', name: 'finish', arguments: { reason: 'No change needed' } }]));
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'paused' });
    const resumed = await resumeTestTask(f.db, f.task.active_run_id);
    expect(await runConversationTask({ ...f.input, runId: resumed.active_run_id })).toMatchObject({ status: 'completed' });
    expect(f.requests()).toBe(1);
    expect((await taskForRun(f.db, resumed.active_run_id))?.model_calls).toBe(1);
  });
});

it.each([false, true])('recovers a failed assistant while retaining diagnostics (message write interrupted: %s)', async interrupted => {
  const f = await fixture();
  const failed = { ...reply([]), stopReason: 'error' as const, errorMessage: '520 error code: 520' };
  if (interrupted) {
    const original = f.db.prepare.bind(f.db);
    let fail = true;
    f.db.prepare = ((sql: string) => {
      if (fail && f.requests() && sql.includes('insert into agent_conversation_messages')) {
        fail = false; throw new Error('Message persistence interrupted');
      }
      return original(sql);
    }) as typeof f.db.prepare;
  }
  f.responses.push(failed, reply([{ id: 'done', name: 'finish', arguments: { reason: 'Recovered' } }]));
  // A failed response is retried in the same host once its diagnostics are saved.
  if (interrupted) {
    expect(await runConversationTask(f.input)).toMatchObject({ status: 'paused' });
    await resumeTestTask(f.db, f.task.active_run_id);
  }
  expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
  const resumed = (await taskForRun(f.db, f.task.active_run_id))!;
  expect(f.requests()).toBe(2);
  expect(f.observations[1]).toContain('Model request failed');
  expect(f.observations[1]).toContain('520 error code');
  expect(JSON.parse(f.observations[1]).messages.some((message: {role:string;stopReason?:string}) => message.role === 'assistant' && message.stopReason === 'error')).toBe(false);
  const records = await f.db.prepare('select response_json from agent_task_model_reservations where task_id = ?').bind(f.task.id).all<{ response_json: string }>();
  expect(records.results.some(row => row.response_json.includes('520 error code'))).toBe(true);
  expect((await taskForRun(f.db, resumed.active_run_id))?.model_calls).toBe(2);
});

it('retains cumulative consumption without injecting obsolete remaining allowances', async () => {
  const f = await fixture();
  await f.db.prepare('update agent_tasks set external_calls = 7,max_external_calls = 20 where id = ?').bind(f.task.id).run();
  f.responses.push(reply([{ id: 'a', name: 'save_fact', arguments: { value: 'fact', revision: 0 } }]),
    reply([{ id: 'done', name: 'finish', arguments: { reason: 'Done' } }]));
  expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
  expect(f.observations[1]).not.toContain('external_calls_remaining');
  const history = (await readConversation(f.db, f.task))!;
  expect(JSON.stringify(history.messages)).not.toContain('root_external_calls_remaining');
  expect((await taskForRun(f.db, f.task.active_run_id))?.external_calls).toBe(7);
});

it.each([false, true])('continues saved assistant history without synthesizing a business reminder (%s)', async hasInput => {
  const f = await fixture();
  await initializeConversation(f.db, f.task, f.input.agent.instructions, {});
  await appendConversationMessage(f.db, f.task, 'trigger', { role: 'user', content: 'Start', timestamp: 1 });
  await appendConversationMessage(f.db, f.task, 'response:2', reply([]));
  if (hasInput) await f.db.prepare('insert into agent_task_inputs(id,task_id,actor_id,content,created_at) values(?,?,?,?,?)')
    .bind('input-1', f.task.id, 'owner', 'Use the new evidence', new Date().toISOString()).run();
  f.responses.push(reply([{ id: 'done', name: 'finish', arguments: { reason: 'Done' } }]));
  expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
  const history = (await readConversation(f.db, f.task))!;
  expect(history.messages.filter(row => row.key.startsWith('completion-reminder:'))).toHaveLength(0);
  expect(f.observations[0]).toContain(hasInput ? 'Use the new evidence' : 'Start');
  expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
  expect(f.requests()).toBe(1);
});

it('does not invoke the model for a cancelled task', async () => {
  const f = await fixture();
  await stopTask(f.db, f.task.active_run_id, 'cancelled', 'User cancelled');
  expect(await runConversationTask(f.input)).toMatchObject({ status: 'cancelled' });
  expect(f.requests()).toBe(0);
});

it.each(['inspect_source', 'inspect_customer'])('preserves %s failures on replay and counts new operations only', async name => {
  const f = await fixture();
  f.input.definition.tools.push(name);
  let executions = 0;
  const originalTools = f.input.agent.tools;
  f.input.agent.tools = (task, operation) => originalTools(task, operation).register({
    name, version: 1, description: 'Inspect state', capability: 'read', retryable: false, timeoutMs: 1000, approval: 'never',
    inputSchema: z.object({}), outputSchema: z.unknown(),
    execute: async () => { executions++; throw Object.assign(new Error('401 Unauthorized'), { status: 401 }); },
  });
  const original = f.db.prepare.bind(f.db);
  let interrupt = true;
  f.db.prepare = ((sql: string) => {
    if (interrupt && executions && sql.includes('insert into agent_conversation_messages')) { interrupt = false; throw new Error('Interrupted result write'); }
    return original(sql);
  }) as typeof f.db.prepare;
  f.responses.push(reply([{ id: 'first', name, arguments: {} }]));
  expect(await runConversationTask(f.input)).toMatchObject({ status: 'paused' });
  const resumed = await resumeTestTask(f.db, f.task.active_run_id);
  f.responses.push(reply([{ id: 'second', name, arguments: {} }]), reply([{ id: 'done', name: 'finish', arguments: { reason: 'Continue without this source' } }]));
  expect(await runConversationTask({ ...f.input, runId: resumed.active_run_id })).toMatchObject({ status: 'completed' });
  expect(executions).toBe(2);
  const history = (await readConversation(f.db, resumed))!;
  for (const id of ['first', 'second'] as const) {
    const message = history.messages.find(row => row.key === `tool:${id}`)!.message;
    expect(message.role).toBe('toolResult');
    if (message.role === 'toolResult' && message.content[0].type === 'text') expect(JSON.parse(message.content[0].text))
      .toMatchObject({ kind: 'not_authorized', retryable: false, effects: 'none' });
  }
});

it.each([
  { retryable: false, safe: true, message: 'fetch failed', expected: 1 },
  { retryable: true, safe: true, message: 'fetch failed', expected: 2 },
  { retryable: true, safe: true, message: '401 Unauthorized', expected: 1 },
  { retryable: true, safe: true, message: 'Unknown implementation failure', expected: 1 },
  { retryable: true, safe: false, message: 'fetch failed', expected: 1 },
])('honors tool and failure retry policy: %j', async policy => {
  const f = await fixture();
  f.input.definition.tools.push('lookup');
  let executions = 0;
  const originalTools = f.input.agent.tools;
  f.input.agent.tools = (task, operation) => originalTools(task, operation).register({
    name: 'lookup', version: 1, description: 'Lookup an external record', capability: 'external',
    retryable: policy.retryable, replaySafety: policy.safe ? 'repeatable' as const : 'unreconciled' as const,
    timeoutMs: 1000, approval: 'never', inputSchema: z.object({}), outputSchema: z.unknown(),
    execute: async () => { executions++; throw Object.assign(new Error(policy.message), policy.message === 'fetch failed' ? { code: 'ECONNRESET' } : policy.message === '401 Unauthorized' ? { status: 401 } : {}); },
  });
  // Model Workflow's bounded retry semantics, including the persisted step result boundary.
  f.input.step = { ...step, do: async (_key: string, config: { retries: { limit: number } }, fn: () => Promise<unknown>) => {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (error) { if (attempt >= config.retries.limit) throw new Error(String(error)); }
    }
  } } as unknown as RuntimeWorkflowStep;
  f.responses.push(reply([{ id: 'lookup', name: 'lookup', arguments: {} }]),
    reply([{ id: 'done', name: 'finish', arguments: { reason: 'Source unavailable' } }]));
  expect(await runConversationTask(f.input)).toMatchObject(policy.safe ? { status: 'completed' } : { status: 'paused', outcome: 'external_pending' });
  expect(executions).toBe(policy.expected);
  if (!policy.safe) {
    await expect(attachTask(f.db, f.run('run-2'), f.input.definition, f.task.active_run_id)).rejects.toThrow('original Run');
    expect(executions).toBe(1);
    expect(f.requests()).toBe(1);
  }
});

it('does not execute partial tool calls from a failed model response and retries in the same host', async () => {
  const f = await fixture();
  const sleeps: string[] = [];
  f.responses.push({ ...reply([{ id: 'partial', name: 'save_fact', arguments: { value: 'must not save', revision: 0 } }]), stopReason: 'error', errorMessage: 'Network connection lost.' },
    reply([{ id: 'done', name: 'finish', arguments: { reason: 'Recovered' } }]));
  expect(await runConversationTask({ ...f.input, step: { ...step, sleep: async (_name: string, duration: string) => { sleeps.push(duration); } } as unknown as RuntimeWorkflowStep }))
    .toMatchObject({ status: 'completed' });
  expect(sleeps).toEqual(['5 seconds']);
  expect(f.effects).toEqual([]);
  const history = (await readConversation(f.db, (await taskForRun(f.db, f.task.active_run_id))!))!;
  expect(history.calls.map(call => call.call_id)).toEqual(['partial','done']);
  expect(history.messages.some(row => row.key.startsWith('model-feedback:'))).toBe(true);
});

it('replaces an inactive host instead of pausing and reuses the model receipt it already saved', async () => {
  const f = await fixture();
  let lost = true;
  const hostStep = { ...step, do: async (key: string, config: unknown, fn?: () => Promise<unknown>) => {
    const value = await step.do(key, config as never, fn as never);
    if (lost && key.startsWith('request-')) {
      lost = false;
      throw new Error('Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.');
    }
    return value;
  } } as unknown as RuntimeWorkflowStep;
  f.responses.push(reply([{ id: 'done', name: 'finish', arguments: { reason: 'Recovered' } }]));
  await expect(runConversationTask({ ...f.input, step: hostStep }))
    .rejects.toMatchObject({ failure: { origin: 'local_platform', scope: 'execution', recovery_action: 'new_execution' } });
  expect((await taskForRun(f.db, f.task.active_run_id))?.status).toBe('running');
  expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
  expect(f.requests()).toBe(1);
});

it('replaces the host only after in-place retries of consecutive dropped responses are exhausted', async () => {
  const f = await fixture();
  const sleeps: string[] = [];
  const dropped = () => ({ ...reply([]), stopReason: 'error', errorMessage: 'Network connection lost.' }) as AssistantMessage;
  f.responses.push(dropped(), dropped(), dropped(), dropped());
  await expect(runConversationTask({ ...f.input, step: { ...step, sleep: async (_name: string, duration: string) => { sleeps.push(duration); } } as unknown as RuntimeWorkflowStep }))
    .rejects.toMatchObject({ failure: { recovery_action: 'retry_request', scope: 'request' } });
  expect(sleeps).toEqual(['5 seconds', '15 seconds', '45 seconds']);
  expect(f.requests()).toBe(4);
  const resumed = await resumeTestTask(f.db, f.task.active_run_id);
  f.responses.push(reply([{ id: 'done', name: 'finish', arguments: { reason: 'Recovered' } }]));
  expect(await runConversationTask({ ...f.input, runId: resumed.active_run_id })).toMatchObject({ status: 'completed' });
});

it('shows a child both its own external allowance and the shared root allowance', async () => {
  const f = await fixture();
  const childRun = { ...f.run('child', 'child'), parent_run_id: f.task.active_run_id };
  await f.db.prepare('update agent_runs set parent_run_id = ? where id = ?').bind(f.task.active_run_id, childRun.id).run();
  const child = await attachTask(f.db, childRun, f.input.definition);
  await f.db.prepare('update agent_tasks set external_calls = 12,max_external_calls = 20,child_reserve_calls = 0,child_reserve_units = 0 where id = ?').bind(f.task.id).run();
  await f.db.prepare('update agent_tasks set external_calls = 2,max_external_calls = 15 where id = ?').bind(child.id).run();
  f.responses.push(reply([{ id: 'a', name: 'save_fact', arguments: { value: 'child fact', revision: 0 } }]),
    reply([{ id: 'done', name: 'finish', arguments: { reason: 'Done' } }]));
  expect(await runConversationTask({ ...f.input, runId: child.active_run_id })).toMatchObject({ status: 'completed' });
  const history = (await readConversation(f.db, child))!;
  expect(history.messages.some(row => row.key.startsWith('runtime-state:'))).toBe(false);
  expect((await taskForRun(f.db, f.task.active_run_id))?.external_calls).toBe(12);
});

it('maintains context after a persisted provider overflow despite a lower local estimate', async () => {
  const f = await fixture(false, 'Facts and exact entity customer-7. '.repeat(100));
  f.responses.push({ ...reply([]), stopReason: 'error', errorMessage: 'Provider rejected capacity', runtimeFailure: 'context_overflow' } as AssistantMessage);
  f.responses.push({ ...reply([]), content: [{ type: 'text', text: 'Task: verify customer-7. No effects yet.' }] });
  f.responses.push(reply([{ id: 'done', name: 'finish', arguments: { reason: 'Completed after capacity maintenance' } }]));
  expect(await runConversationTask(f.input)).toMatchObject({ status: 'completed' });
  expect(f.requests()).toBe(3);
  expect(f.observations.at(-1)).toContain('customer-7');
  expect(await f.db.prepare('select count(*) as n from agent_conversation_compactions').first('n')).toBe(1);
  expect(await f.db.prepare('select count(*) as n from agent_runs').first('n')).toBe(1);
});

it.each([429, 503, 401, 403, 400])('routes HTTP %s from the provider: transient statuses retry in place, account refusals wait in a new execution, request rejections pause', async status => {
  const f = await fixture();
  const sleeps: string[] = [];
  const channel = conversationChannel(testModelProfile({ model: 'fixture', contextWindow: 32000, maxOutputTokens: 1000, reasoningSupported: false }));
  const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 'resp-2', object: 'chat.completion.chunk', created: 1, model: 'fixture',
    choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`;
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Synthetic provider failure' } }), { status, headers: { 'content-type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'done', type: 'function', function: { name: 'finish', arguments: '{"reason":"Recovered"}' } }] })
      + chunk({}, 'tool_calls') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', fetch);
  try {
    const run = runConversationTask({ ...f.input, transport: channel,
      step: { ...step, sleep: async (_name: string, duration: string) => { sleeps.push(duration); } } as unknown as RuntimeWorkflowStep });
    if (status === 400) {
      await expect(run).rejects.toMatchObject({ failure: { status, recovery_action: 'pause' } });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    } else if (status === 401 || status === 403) {
      await expect(run).rejects.toMatchObject({ failure: { status, scope: 'account', recovery_action: 'new_execution' } });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
      expect((await taskForRun(f.db, f.task.active_run_id))?.status).toBe('running');
      // The replacement execution discards the refused receipt and asks again with the saved conversation.
      f.input.env.execution = { taskId: f.task.id, runId: f.task.active_run_id, executionId: 'execution-2', epoch: 2 };
      expect(await runConversationTask({ ...f.input, transport: channel })).toMatchObject({ status: 'completed', reason: 'Recovered' });
      expect(fetch).toHaveBeenCalledTimes(2);
    } else {
      expect(await run).toMatchObject({ status: 'completed', reason: 'Recovered' });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sleeps).toEqual(['5 seconds']);
    }
  } finally { vi.unstubAllGlobals(); }
});

it('sends the public progress contract in the serialized provider request and persists decoded text beside real tool receipts', async () => {
  const f = await fixture();
  const wire: unknown[] = [];
  const delta = { role: 'assistant', content: 'Materials verification is complete; submitting this round\'s results.', reasoning_content: 'PRIVATE', tool_calls: [{ index: 0, id: 'done', type: 'function', function: { name: 'finish', arguments: '{"reason":"Done"}' } }] };
  const chunk = (value: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    wire.push(JSON.parse(String(init.body)));
    return new Response(chunk(delta) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const transport = conversationChannel(testModelProfile({ model: 'fixture', contextWindow: 32000, maxOutputTokens: 1000, reasoningSupported: false }));
    expect(await runConversationTask({ ...f.input, transport })).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(wire[0])).toContain('[public-work-progress-v1]');
    expect(JSON.stringify(wire[0])).toContain('system language en (English)');
    expect(JSON.stringify(wire[0])).toContain('Article bodies, market research terms and exact source quotations keep their assigned language');
    expect(JSON.stringify(wire[0])).not.toContain('in Simplified Chinese');
    expect(JSON.stringify(wire[0])).toContain('Do not claim effects before their receipts confirm them');
    expect(f.sqlite.prepare('select body from agent_work_notes').all()).toEqual([{ body: 'Materials verification is complete; submitting this round\'s results.' }]);
    expect(f.sqlite.prepare('select status from agent_task_operations').all()).toEqual([{ status: 'succeeded' }]);
  } finally { vi.unstubAllGlobals(); }
});
