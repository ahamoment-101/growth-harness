// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('agents', () => ({ getAgentByName: vi.fn() }));
import { z } from 'zod';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { taskTestDb, resumeTestTask } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, beginTaskDecision, requireTask, setTaskAction, stopTask, taskForRun, taskResumeBlocker } from './task-store';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { ToolRegistry, type RuntimeTool } from './tools';
import { runConversationTask, type ConversationAgent } from './conversation-runtime';
import { replayConversationResponse } from './conversation-replay';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution, ExecutionHandoff } from './runtime-executions';
import { executionEnvironment } from './execution-context';
import { registeredRuntimeAgentModules } from './agent-modules';
import { strategyTaskTools } from './strategy-task';

const model: Model<'openai-completions'> = { id: 'test', name: 'test', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid',
  reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function reply(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): AssistantMessage {
  return { role: 'assistant', content: calls.map(c => ({ type: 'toolCall', ...c })), api: model.api, provider: model.provider, model: model.id,
    stopReason: calls.length ? 'toolUse' : 'stop', timestamp: 1,
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

/** The host is terminated while a tool step runs: nothing after the gate is persisted. */
async function interruptedLookup(declaration: Partial<Pick<RuntimeTool, 'replaySafety'>>) {
  const state = taskTestDb();
  const definition = { ...agentDefinition('strategy_research'), stagePolicy: undefined, tools: ['lookup_suggestions', 'finish'] };
  const task = await attachTask(state.db, state.run(), definition);
  let killHost = true;
  const calls: string[] = [];
  const step = { do: async (key: string, config: unknown, fn?: () => Promise<unknown>) => {
    if (killHost && key.startsWith('conversation-tool-')) { killHost = false; throw new ExecutionHandoff(); }
    return (fn || config as () => Promise<unknown>)();
  }, sleep: async () => {}, waitForEvent: async () => ({ payload: {} }) } as unknown as RuntimeWorkflowStep;
  const agent: ConversationAgent = {
    instructions: 'Research', context: async () => ({}), completionInstructions: 'Finish explicitly.',
    tools: () => new ToolRegistry()
      .register({ name: 'lookup_suggestions', version: 1, description: 'External read-only lookup', capability: 'external', timeoutMs: 1000, retryable: true,
        approval: 'never', ...declaration, inputSchema: z.object({ seed: z.string() }), outputSchema: z.object({ suggestions: z.array(z.string()) }),
        execute: async input => { calls.push(input.seed); return { suggestions: [`${input.seed} online`] }; } })
      .register({ name: 'finish', version: 1, description: 'Finish', capability: 'write', replaySafety: 'idempotent', timeoutMs: 1000, retryable: false, approval: 'never',
        inputSchema: z.object({ reason: z.string() }), outputSchema: z.object({ reason: z.string() }), execute: async input => input,
        completion: output => ({ status: 'completed', outcome: 'done', reason: output.reason, output }) }),
  };
  const responses = [reply([{ id: 'lookup', name: 'lookup_suggestions', arguments: { seed: 'google translate for writing' } }])];
  const stream: StreamFn = (m, context, options) => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected provider call');
    return replayConversationResponse(response, stream)(m, context, options);
  };
  const input = { env: { DB: state.db } as RuntimeAgentEnv, step, runId: task.active_run_id, definition, agent, transport: { model, stream } };
  await expect(runConversationTask(input)).rejects.toBeInstanceOf(ExecutionHandoff);
  return { ...state, input, task, calls, responses };
}

describe('interrupted tool effects', () => {
  it('recovers an interrupted repeatable external read by running it again', async () => {
    const f = await interruptedLookup({ replaySafety: 'repeatable' });
    expect(await taskResumeBlocker(f.db, (await taskForRun(f.db, f.task.active_run_id))!)).toBeNull();
    const resumed = await resumeTestTask(f.db, f.task.active_run_id);
    f.responses.push(reply([{ id: 'done', name: 'finish', arguments: { reason: 'Suggestions observed' } }]));
    expect(await runConversationTask({ ...f.input, runId: resumed.active_run_id })).toMatchObject({ status: 'completed' });
    expect(f.calls).toEqual(['google translate for writing']);
  });

  it('refuses to register a non-read tool that does not declare its interrupted-effect contract', () => {
    expect(() => new ToolRegistry().register({ name: 'undeclared_lookup', version: 1, description: 'x', capability: 'external', timeoutMs: 1, retryable: false,
      approval: 'never', inputSchema: z.object({}), outputSchema: z.object({}) })).toThrow('interrupted-effect');
  });

  it('keeps blocking an interrupted operation whose tool is explicitly unreconciled', async () => {
    const f = await interruptedLookup({ replaySafety: 'unreconciled' as never });
    expect(await taskResumeBlocker(f.db, (await taskForRun(f.db, f.task.active_run_id))!)).toMatchObject({ kind: 'unknown_effect', tool: 'lookup_suggestions' });
  });

  it('every registered Agent tool declares its interrupted-effect contract', () => {
    const env = { DB: {} } as unknown as RuntimeAgentEnv;
    const undeclared: string[] = [];
    for (const module of registeredRuntimeAgentModules()) {
      const registry = module.createToolRegistry?.(env);
      if (!registry) continue;
      registry.mapTools(tool => { if (tool.capability !== 'read' && !tool.replaySafety) undeclared.push(`${module.definition.id}:${tool.name}`); return tool; });
    }
    expect(undeclared).toEqual([]);
  });
});

describe('parent resume receipts', () => {
  const brief = { market: 'Global', research_question: 'Which English writing tasks do learners search for?', directions: ['reply to English emails'] };
  it('tells the parent a blocked child was not resumed and cannot be resumed as is', async () => {
    const f = taskTestDb();
    f.sqlite.exec(`alter table sites add column workspace_id text default 'w'; alter table sites add column source_locale text default 'en';
      alter table sites add column translate_locales_json text default '["pt-BR"]'; alter table sites add column hub_path text default '';
      create table topics(id text primary key,site_id text,title_hint text,status text); alter table topics add column plan_json text default '{}';`);
    // @ts-ignore Test-only URL.
    f.sqlite.exec(readFileSync(new URL('../../migrations/0056_keyword_library.sql', import.meta.url), 'utf8'));
    f.sqlite.exec(readFileSync(new URL('../../migrations/0075_language_only_library.sql', import.meta.url).pathname, 'utf8'));
    const definition = agentDefinition('strategy_research');
    const parent = await attachTask(f.db, f.run(), definition);
    const execution = await createRuntimeExecution(f.db, parent.active_run_id);
    await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
    // The child was interrupted inside an undeclared external step and paused by recovery.
    const create = vi.fn(async (options: { id: string; params: { runId: string } }) => {
      const child = (await taskForRun(f.db, options.params.runId))!;
      const op = await beginTaskDecision(f.db, child, {});
      await setTaskAction(f.db, child, op, { name: 'fetch_autocomplete', input: { seed: 'google translate for writing' } });
      await f.db.prepare(`update agent_task_operations set status='running',external_json='{"replay_safety":"unknown"}' where id=?`).bind(op.id).run();
      await stopTask(f.db, options.params.runId, 'paused', 'interrupted', 'external_pending');
      // The child's host ended; its Run is no longer active for the parent's wait.
      await f.db.prepare("update agent_runs set status='failed' where id=?").bind(options.params.runId).run();
      return { id: options.id };
    });
    const scoped = executionEnvironment({ DB: f.db, AGENT_WORKFLOW: { create, get: vi.fn() } } as unknown as RuntimeAgentEnv, authorityForExecution(execution));
    const delegate = async (resumeTaskId: string) => {
      const task = await requireTask(scoped.DB, parent.active_run_id);
      const operation = await beginTaskDecision(scoped.DB, task, {});
      const args = { ...brief, locale: 'en', resume_task_id: resumeTaskId, judgment_summary: '' };
      await setTaskAction(scoped.DB, task, operation, { name: 'research_keywords', input: args });
      const tools = strategyTaskTools({ env: scoped, definition, step: { do: async (_k: string, c: unknown, fn?: () => Promise<unknown>) => (fn || c as () => Promise<unknown>)(), sleep: async () => {} } as never,
        runId: task.active_run_id, task, operation, locale: 'en' });
      const result = await tools.resolve(definition, 'research_keywords').execute!(args, { workspaceId: 'w', siteId: 's', runId: task.active_run_id, idempotencyKey: operation.id }) as Record<string, any>;
      await f.db.prepare(`update agent_task_operations set status='succeeded' where id=?`).bind(operation.id).run();
      await f.db.prepare(`update agent_tasks set next_turn=next_turn+1 where id=?`).bind(task.id).run();
      return result;
    };
    const first = await delegate('');
    expect(first).toMatchObject({ status: 'paused', resumable: false, resume_block: { kind: 'unknown_effect', tool: 'fetch_autocomplete' } });
    expect(first).not.toHaveProperty('resume_performed');
    const resumed = await delegate(first.task_id);
    expect(resumed).toMatchObject({ status: 'paused', resumable: false, resume_performed: false,
      resume_block: { kind: 'unknown_effect', tool: 'fetch_autocomplete', reason: expect.stringContaining('cannot execute again') } });
    expect(create).toHaveBeenCalledOnce();
    expect(JSON.stringify(resumed)).not.toMatch(/reconcile it|redelegate|start a new/i);
  });
});
