import { describe, expect, it, vi } from 'vitest';
vi.mock('agents', () => ({ getAgentByName: vi.fn() }));
import { z } from 'zod';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context, Model } from '@earendil-works/pi-ai';
import { HITL_RESOLUTION_INSTRUCTIONS, HITL_RESOLUTION_TOOL_NAMES } from '../agent-work/hitl-resolution';
import { observeChildInput, provideChildFacts } from './child-input';
import { runConversationTask, type ConversationAgent } from './conversation-runtime';
import { replayConversationResponse } from './conversation-replay';
import { readConversation } from './conversation-store';
import { agentDefinition } from './definitions';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { executionEnvironment } from './execution-context';
import { startRuntimeRun } from './run-service';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution, currentExecution } from './runtime-executions';
import { attachTask, beginTaskDecision, requireTask, taskForRun } from './task-store';
import { taskTestDb } from './task-test-db';
import { ToolRegistry } from './tools';

const model: Model<'openai-completions'> = { id: 'synthetic-contract', name: 'Synthetic contract stream', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.invalid',
  reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const step = { do: async (_key: string, config: unknown, fn?: () => Promise<unknown>) => (fn || config as () => Promise<unknown>)(), sleep: async () => {} } as unknown as RuntimeWorkflowStep;
const question = { spec: { schema_version: 1, title: 'Confirm the supported market', blocks: [{ type: 'text', text: 'The current brief does not establish whether market A is supported.' }], actions: [{ id: 'confirm', label: 'Confirm' }] }, resume_when: 'Reassess when supporting information arrives.' };

function reply(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'toolUse', timestamp: 1,
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

/** Real Runtime, persistence and child startup; only the provider stream and
 * Workflow transport are synthetic. This does not measure real model judgment. */
async function fixture(legacy = false) {
  const f = taskTestDb();
  f.sqlite.exec("alter table sites add column workspace_id text default 'w'");
  const parent = await attachTask(f.db, f.run('parent', 'parent'), agentDefinition('strategy_research'));
  const parentExecution = await createRuntimeExecution(f.db, parent.active_run_id);
  await activateRuntimeExecution(f.db, authorityForExecution(parentExecution), parentExecution.workflow_id);
  const create = vi.fn(async (input: { id: string; params: unknown }) => ({ id: input.id }));
  const host = { DB: f.db, AGENT_RUNTIME_ENABLED: 'true', AGENT_WORKFLOW: { create, get: async () => { throw new Error('not found'); } } } as unknown as RuntimeAgentEnv;
  const parentEnv = executionEnvironment(host, authorityForExecution(parentExecution));
  await startRuntimeRun(parentEnv, { runId: 'research-child', instanceId: 'research-child', workspaceId: 'w', siteId: 's', agentId: 'business_research',
    trigger: 'sub_agent', parentRunId: parent.active_run_id, summary: { task: 'Establish supported market facts', locale: 'en' },
    initialAssignment: { id: 'original-assignment', material: { goal: 'Establish market support from attributable evidence', constraints: 'No publication or permission changes' } } });
  const originalExecution = (await currentExecution(f.db, 'research-child'))!;
  await activateRuntimeExecution(f.db, authorityForExecution(originalExecution), originalExecution.workflow_id);
  const definition = { ...agentDefinition('business_research'), stagePolicy: undefined,
    tools: ['finish', 'request_human_input', ...HITL_RESOLUTION_TOOL_NAMES] };
  if (legacy) f.sqlite.prepare('update agent_tasks set definition_version=? where id=?').run(definition.hitlResolutionSinceVersion! - 1, 'research-child');
  const agent: ConversationAgent = { instructions: 'Research the assigned business fact from the evidence available in this task.',
    context: async () => ({ goal: 'Determine whether market A is supported', unknowns: ['Supported markets have not yet been established.'] }),
    completionInstructions: 'Finish only when the business fact is adequately established; waiting is a legitimate outcome.',
    tools: () => new ToolRegistry().register({ name: 'finish', version: 1, description: 'Return an evidence-backed business conclusion.', capability: 'write', replaySafety: 'idempotent',
      timeoutMs: 1000, retryable: false, approval: 'never', inputSchema: z.object({ summary: z.string() }), outputSchema: z.object({ summary: z.string() }),
      execute: async input => input, completion: output => ({ status: 'completed', outcome: 'completed', reason: output.summary, output }) }),
  };
  const responses: Array<(context: Context) => AssistantMessage> = [];
  const calls: Context[] = [];
  const stream: StreamFn = (selected, context, options) => {
    calls.push(JSON.parse(JSON.stringify(context)) as Context);
    const next = responses.shift();
    if (!next) throw new Error('Unexpected synthetic provider call');
    return replayConversationResponse(next(context), stream)(selected, context, options);
  };
  const run = async () => {
    const execution = (await currentExecution(f.db, 'research-child'))!;
    const env = executionEnvironment(host, authorityForExecution(execution));
    return runConversationTask({ env, step, runId: 'research-child', definition, agent, transport: { model, stream } });
  };
  return { ...f, host, parent, parentEnv, originalExecution, definition, responses, calls, create, run };
}

describe('parent facts through the original child Agent loop', () => {
  it.each(['withdraw', 'keep_waiting'] as const)('lets the resumed child choose %s without treating parent facts as a human answer', async decision => {
    const f = await fixture();
    f.responses.push(() => reply('question', 'request_human_input', question));
    expect(await f.run()).toMatchObject({ status: 'waiting' });
    const waiting = (await taskForRun(f.db, 'research-child'))!;
    expect(waiting.agent_id).toBe('business_research');
    expect(f.parent.agent_id).toBe('strategy_research');
    const before = (await readConversation(f.db, waiting))!;
    const request = f.sqlite.prepare('select request_id,version,node_json,state from agent_work_requests where task_id=?').get(waiting.id) as { request_id: string; version: string; node_json: string; state: string };
    expect(request.state).toBe('pending');

    const parent = await requireTask(f.parentEnv.DB, f.parent.active_run_id);
    const operation = await beginTaskDecision(f.parentEnv.DB, parent, {});
    const inputRef = await observeChildInput(f.parentEnv, parent, waiting);
    expect(inputRef).toBeTruthy();
    const facts = decision === 'withdraw' ? 'Official documentation lists market A as supported.' : 'An old unofficial comment mentions market A; the current product coverage is still uncertain.';
    const input = { input_ref: inputRef!, facts, sources: ['Observed document reference, market coverage section'] };
    const supplied = await provideChildFacts(f.parentEnv, parent, operation, input);
    expect(supplied).toMatchObject({ task_ref: waiting.id, run_ref: waiting.active_run_id, input_saved: true });
    await provideChildFacts(f.parentEnv, parent, operation, input);
    expect(f.sqlite.prepare('select count(*) n from agent_task_inputs').get()).toEqual({ n: 1 });
    const resumedExecution = (await currentExecution(f.db, waiting.active_run_id))!;
    expect(resumedExecution.id).not.toBe(f.originalExecution.id);
    await activateRuntimeExecution(f.db, authorityForExecution(resumedExecution), resumedExecution.workflow_id);
    f.responses.push(
      context => {
        expect(JSON.stringify(context.messages)).toContain(facts);
        expect(JSON.stringify(context.messages)).toContain('parent_facts');
        expect(JSON.stringify(context.messages)).toContain('not a human response or approval');
        return reply('read-question', 'read_human_input_requests', {});
      },
      context => {
        const last = [...context.messages].reverse().find(message => message.role === 'toolResult' && message.toolName === 'read_human_input_requests');
        if (!last || last.role !== 'toolResult') throw new Error('Missing actual pending request tool result');
        const text = last.content.find(part => part.type === 'text');
        if (!text || text.type !== 'text') throw new Error('Missing pending request result text');
        const output = JSON.parse(text.text) as { requests: Array<{ request_ref: string; request_id: string }> };
        expect(output.requests).toHaveLength(1);
        expect(output.requests[0].request_id).toBe(request.request_id);
        return reply('resolve-question', 'resolve_human_input_request', { request_ref: output.requests[0].request_ref, decision,
          reason: decision === 'withdraw' ? 'The attributed official documentation resolves this information gap.' : 'The parent evidence is insufficient; await the original question.' });
      },
    );
    if (decision === 'withdraw') f.responses.push(() => reply('finish', 'finish', { summary: 'Supported market established from attributed documentation.' }));
    expect(await f.run()).toMatchObject({ status: decision === 'withdraw' ? 'completed' : 'waiting' });
    const afterTask = (await taskForRun(f.db, waiting.active_run_id))!;
    const after = (await readConversation(f.db, afterTask))!;
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(after.messages.filter(message => message.key === `input:${supplied.input_id}`)).toHaveLength(1);
    expect(after.context).toEqual(before.context);
    expect(after.instructions).toBe(before.instructions);
    expect(after.instructions).toContain(HITL_RESOLUTION_INSTRUCTIONS);
    expect(afterTask.active_run_id).toBe(waiting.active_run_id);
    expect(f.sqlite.prepare('select count(*) n from agent_runs').get()).toEqual({ n: 2 });
    expect(f.sqlite.prepare('select count(*) n from agent_work_requests').get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare('select count(*) n from agent_work_responses').get()).toEqual({ n: 0 });
    expect(f.sqlite.prepare('select node_json,state from agent_work_requests').get()).toEqual({ node_json: request.node_json, state: decision === 'withdraw' ? 'resolved' : 'pending' });
    expect(f.sqlite.prepare("select count(*) n from agent_task_model_reservations where task_id=? and status='succeeded'").get(waiting.id)).toEqual({ n: decision === 'withdraw' ? 4 : 3 });
    expect(f.responses).toHaveLength(0);
    // Replaying the parent's old supplement cannot resume a later child wait.
    f.create.mockClear();
    await provideChildFacts(f.parentEnv, parent, operation, input);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('select count(*) n from agent_task_inputs').get()).toEqual({ n: 1 });
    expect((await taskForRun(f.db, waiting.active_run_id))!.status).toBe(afterTask.status);
  });

  it('keeps pre-upgrade task tools and instructions pinned without injecting resolution capabilities', async () => {
    const f = await fixture(true);
    f.responses.push(() => reply('legacy-question', 'request_human_input', question));
    expect(await f.run()).toMatchObject({ status: 'waiting' });
    const child = (await taskForRun(f.db, 'research-child'))!;
    const snapshot = (await readConversation(f.db, child))!;
    expect(snapshot.instructions).not.toContain(HITL_RESOLUTION_INSTRUCTIONS);
    const names = f.calls[0].tools?.map(tool => tool.name) || [];
    expect(names).toContain('request_human_input');
    expect(names).not.toContain('read_human_input_requests');
    expect(names).not.toContain('resolve_human_input_request');
    const pinned = f.sqlite.prepare('select tool_manifest_json from agent_conversations where task_id=?').get(child.id) as { tool_manifest_json: string };
    expect(pinned.tool_manifest_json).not.toContain('resolve_human_input_request');
    expect(f.sqlite.prepare('select count(*) n from agent_work_requests').get()).toEqual({ n: 1 });
  });
});
