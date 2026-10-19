import { describe, expect, it } from 'vitest';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { taskTestDb } from './task-test-db';
import { attachTask, finishTaskOperation, requireTask, taskDataJson } from './task-store';
import { agentDefinition } from './definitions';
import { appendConversationMessage, bindConversationOperation, closePendingConversationCalls, initializeConversation, readConversation } from './conversation-store';
import { persistRuntimeJson, readRuntimeJson } from './runtime-content';
import { resultForTask } from './research-contract';
import { researchDeliveryView } from './research-delivery-view';
import { toolResultView } from './tool-result-view';
import { strategyTaskTools } from './strategy-task';
import type { RuntimeAgentEnv } from './env';
import type { RuntimeWorkflowStep } from './env';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { runConversationTask } from './conversation-runtime';
import { replayConversationResponse } from './conversation-replay';
import { ToolRegistry } from './tools';

const receipt = () => ({ task_id: 'child', outcome: 'partial', summary: 'Contradictory sources',
  report: 'Full report with a report-only limitation. '.repeat(3000),
  findings: [{ claim: 'Not established', kind: 'uncertain', evidence: [
    { source_id: 'source', quote: 'contradictory quote', relation: 'contradicts' },
  ] }], unknowns: ['Local applicability'], sources: [{ id: 'source', url: 'https://example.com', title: 'Source',
    captured_at: '2026-01-01', evidence_type: 'provider_excerpt', excerpt: 'contradictory quote' }],
  reason: 'Remaining uncertainty', questions: [],
});
const message = (output = receipt()): ToolResultMessage => ({ role: 'toolResult', toolName: 'deep_research', toolCallId: 'research',
  timestamp: 2, isError: false, content: [{ type: 'text', text: taskDataJson(output) }] });
const assistant: AssistantMessage = { role: 'assistant', content: [{ type: 'toolCall', id: 'research', name: 'deep_research', arguments: {} }],
  api: 'openai-completions', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: 1,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

describe('versioned research delivery', () => {
  it('sends the compact view to the next model decision through the real Runtime pipeline', async () => {
    const f = taskTestDb();
    const definition = { ...agentDefinition('strategy_research'), tools: ['deep_research', 'finish'] };
    const task = await attachTask(f.db, f.run(), definition);
    const model: Model<'openai-completions'> = { id: 'test', name: 'test', api: 'openai-completions', provider: 'test',
      baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    let calls = 0; const requests: string[] = [];
    const stream: StreamFn = (model, context, options) => {
      requests.push(JSON.stringify(context));
      const response = calls++ === 0 ? assistant : { ...assistant, content: [{ type: 'toolCall' as const, id: 'finish', name: 'finish', arguments: {} }] };
      return replayConversationResponse(response, stream)(model, context, options);
    };
    const common = { version: 2, capability: 'read' as const, timeoutMs: 1000, retryable: false,
      approval: 'never' as const, inputSchema: z.object({}), outputSchema: z.unknown() };
    const result = await runConversationTask({ env: { DB: f.db } as RuntimeAgentEnv, definition, runId: task.active_run_id,
      step: { do: async (_key: string, config: unknown, fn?: () => Promise<unknown>) => (fn || config as () => Promise<unknown>)() } as RuntimeWorkflowStep,
      transport: { model, stream }, agent: {
        instructions: 'Synthetic delivery acceptance', context: async () => ({}), completionInstructions: 'Finish explicitly',
        tools: () => new ToolRegistry()
          .register({ ...common, name: 'deep_research', description: 'Research', execute: async () => receipt() })
          .register({ ...common, name: 'finish', description: 'Finish', execute: async () => ({}),
            completion: () => ({ status: 'completed', outcome: 'done', reason: 'Test', output: {} }) }),
      },
    });
    expect(result.status).toBe('completed');
    expect(calls).toBe(2);
    const delivered = JSON.parse(requests[1]).messages.find((item: any) => item.role === 'toolResult');
    expect(JSON.parse(delivered.content[0].text)).toMatchObject({ findings: receipt().findings, report_access: { research_task_id: 'child' } });
    expect(requests[1]).not.toContain('Full report with a report-only limitation.');
    const operation = await f.db.prepare("select output_json from agent_task_operations where task_id=? and json_extract(action_json,'$.name')='deep_research'")
      .bind(task.id).first<{output_json: string}>();
    expect(await readRuntimeJson(f.db, operation!.output_json)).toEqual(receipt());
    f.sqlite.close();
  });
  it.each(['completed', 'partial', 'failed', 'needs_input', 'paused', 'cancelled', 'no_findings'])('preserves %s and every decision fact', outcome => {
    const full = { ...receipt(), outcome, completion_assessment: { limitations: 'Only remote market evidence' } };
    const view = researchDeliveryView(full);
    expect(view).toMatchObject({ outcome, findings: full.findings, unknowns: full.unknowns, completion_assessment: full.completion_assessment });
    expect(view).not.toHaveProperty('report');
    expect(view).not.toHaveProperty('sources');
    expect(view.source_access).toMatchObject({ source_id: '', research_task_id: 'child' });
    expect(view.view_coverage.limitation).toContain('qualifications');
    expect(full.report).toBe(receipt().report);
  });

  it('uses one projection on normal append and recovery, retaining the full durable operation', async () => {
    for (const recovery of [false, true]) {
      const f = taskTestDb();
      const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
      await initializeConversation(f.db, task, 'Role', {});
      await appendConversationMessage(f.db, task, 'response', assistant);
      const operation = await bindConversationOperation(f.db, task, 'research', {});
      await finishTaskOperation(f.db, task, operation, receipt());
      if (recovery) await closePendingConversationCalls(f.db, task.active_run_id, 'Recovered');
      else await appendConversationMessage(f.db, task, 'tool:research', message());
      const current = await requireTask(f.db, task.active_run_id);
      await appendConversationMessage(f.db, current, 'tool:research', { ...message(), timestamp: 99 });
      const messages = (await readConversation(f.db, current, { archive: true }))!.messages;
      const saved = messages.at(-1)!.message as ToolResultMessage;
      const view = JSON.parse((saved.content[0] as { text: string }).text);
      expect(view).toMatchObject({ findings: receipt().findings, receipt_integrity: { algorithm: 'sha256' } });
      expect(view).not.toHaveProperty('report');
      const row = await f.db.prepare('select output_json from agent_task_operations where id=?').bind(operation.id).first<{output_json: string}>();
      expect(await readRuntimeJson(f.db, row!.output_json)).toEqual(receipt());
      await expect(appendConversationMessage(f.db, current, 'tool:research', message({ ...receipt(), report: 'X' + receipt().report.slice(1) }))).rejects.toThrow('different content');
      expect(current.status).toBe('running');
      expect(messages).toHaveLength(2);
      f.sqlite.close();
    }
  });

  it('keeps historical contracts and error messages unchanged and supports another domain view', async () => {
    const views = agentDefinition('strategy_research').toolResultViews;
    for (const version of [0, 1]) expect(await toolResultView(message(), views, version)).toEqual(message());
    const error = { ...message(), isError: true };
    expect(await toolResultView(error, views, 2)).toEqual(error);
    const other = { ...message(), toolName: 'inspect_inventory', content: [{ type: 'text' as const, text: '{"items":[1,2]}' }] };
    const output = await toolResultView(other, { 7: { inspect_inventory: () => ({ inventory_ref: 'saved' }) } }, 7) as ToolResultMessage;
    expect(JSON.parse((output.content[0] as { text: string }).text)).toMatchObject({ inventory_ref: 'saved' });
  });

  it('restores chunked reports and exposes versioned report/source handles without repeated excerpts', async () => {
    const f = taskTestDb();
    const definition = agentDefinition('strategy_research');
    const task = await attachTask(f.db, f.run(), definition);
    const childRun = f.run('child', 'child');
    await f.db.prepare("update agent_runs set agent_id='deep_research' where id='child'").run();
    const child = await attachTask(f.db, { ...childRun, agent_id: 'deep_research' }, agentDefinition('deep_research'));
    const full = receipt();
    const stored = await persistRuntimeJson(f.db, full);
    expect(JSON.parse(stored)).toHaveProperty('$runtime_content');
    await f.db.prepare("update agent_tasks set status='completed',output_json=?,goal_json=? where id='child'")
      .bind(stored, '{"locale":"pt-BR"}').run();
    const env = { DB: f.db } as RuntimeAgentEnv;
    expect((await resultForTask(env, { ...child, output_json: stored })).report).toBe(full.report);
    const registry = strategyTaskTools({ env, definition, task, runId: task.active_run_id, locale: 'en' });
    const tool = registry.resolve(definition, 'read_evidence');
    const read = async (args: unknown) => tool.execute!(tool.inputSchema.parse(args), {
      runId: task.active_run_id, workspaceId: 'w', siteId: 's', idempotencyKey: 'test',
    }) as Promise<Record<string, any>>;
    const catalog = await read(researchDeliveryView(full).source_access);
    expect(catalog).toMatchObject({ locale: 'pt-BR', scope: 'cross_market', total_sources: 1 });
    expect(catalog.sources[0]).not.toHaveProperty('excerpt');
    const source = await read({ section: 'source', research_task_id: 'child', source_id: catalog.sources[0].id });
    expect(source).toMatchObject({ excerpt: full.sources[0].excerpt, independently_verified: false });
    expect(source.source).not.toHaveProperty('excerpt');
    let text = ''; let offset: number | null = 0;
    do {
      const part = await read({ section: 'report', research_task_id: 'child', offset });
      expect(part).not.toHaveProperty('sources');
      text += part.excerpt; offset = part.next_offset;
    } while (offset !== null);
    expect(JSON.parse(text)).toEqual(full);
    await expect(read({ section: 'source', research_task_id: 'foreign', source_id: 'source' })).rejects.toThrow('this site');
    const oldTask = { ...task, parameter_contract_version: 1 };
    const old = strategyTaskTools({ env, definition, task: oldTask }).resolve(definition, 'deep_research');
    expect(old.description).not.toContain('report-only');
    expect(tool.version).toBe(2);
    expect(strategyTaskTools({ env, definition, task: oldTask }).resolve(definition, 'read_evidence').version).toBe(1);
    f.sqlite.close();
  });
});
