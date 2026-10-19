import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { agentDefinition } from './definitions';
import { runRuntimeLoop, type RuntimeToolEvent } from './loop';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolCall(toolName: string, input: Record<string, unknown> = {}): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId: `${toolName}-call`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage,
    warnings: [],
  };
}

const site = {
  id: 'site-1',
  name: 'Example',
  domain: 'example.com',
  productBrief: 'A testing product',
  researchSeedTerms: ['agent runtime'],
  competitorDomains: ['competitor.example'],
};

describe('runRuntimeLoop', () => {
  it('rejects strategy research at the legacy probe entry point', async () => {
    const generate = vi.fn();
    const startWorkflow = vi.fn();
    await expect(runRuntimeLoop({
      model: new MockLanguageModelV4({ doGenerate: generate }),
      definition: agentDefinition('strategy_research'), site,
      onToolEvent: async () => {}, startWorkflow,
    })).rejects.toThrow('does not support the legacy Runtime probe loop');
    expect(generate).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('runs the router-specific tools before starting the durable workflow', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCall('read_runtime_identity'),
        toolCall('read_synthetic_context'),
        toolCall('start_durable_probe', { summary: 'Context has been read, can execute persistently' }),
      ],
    });
    const events: RuntimeToolEvent[] = [];
    const startWorkflow = vi.fn(async () => 'workflow-1');

    const result = await runRuntimeLoop({
      model,
      definition: agentDefinition('runtime_synthetic'),
      site,
      onToolEvent: async (event) => { events.push(event); },
      startWorkflow,
    });

    expect(result.workflowId).toBe('workflow-1');
    expect(result.toolCalls).toEqual([
      'read_runtime_identity',
      'read_synthetic_context',
      'start_durable_probe',
    ]);
    expect(events.filter((event) => event.phase === 'completed').map((event) => event.tool)).toEqual(result.toolCalls);
    expect(startWorkflow).toHaveBeenCalledOnce();
  });

  it('does not start a workflow when the model skips required context', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall('start_durable_probe', { summary: 'Skip context' })],
    });
    const startWorkflow = vi.fn(async () => 'workflow-should-not-start');

    await expect(runRuntimeLoop({
      model,
      definition: agentDefinition('runtime_synthetic'),
      site,
      onToolEvent: async () => {},
      startWorkflow,
    })).rejects.toThrow('Agent loop did not start a durable Workflow');
    expect(startWorkflow).not.toHaveBeenCalled();
  });
});
