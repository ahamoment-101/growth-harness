import { describe, expect, it, vi } from 'vitest';
import { failRunningRuntimeTools, modelUsageFromAiSdk, traceRuntimeModel, traceRuntimeModelValue, traceRuntimeTool } from './observability';

function modelDb() {
  let row: { status: string; result_json: string } | null = null;
  let aggregateCalls = 0;
  let lastModelArgs: unknown[] = [];
  let aggregateSql = '';
  return {
    db: {
      prepare: vi.fn((sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes('select id from agent_runs')) return { id: 'run-1' };
            if (sql.includes('select result_json from agent_model_calls')) return row;
            return null;
          },
          run: async () => {
            if (sql.startsWith('insert into agent_model_calls')) {
              lastModelArgs = args;
              row = sql.includes("'succeeded'")
                ? { status: 'succeeded', result_json: String(args[11]) }
                : { status: 'failed', result_json: String(args[12] || '{}') };
            }
            if (sql.startsWith('update agent_runs set')) {
              aggregateCalls += 1;
              aggregateSql = sql;
            }
            return { meta: { changes: 1 } };
          },
        }),
      })),
    },
    row: () => row,
    aggregateCalls: () => aggregateCalls,
    lastModelArgs: () => lastModelArgs,
    aggregateSql: () => aggregateSql,
  };
}

describe('Runtime observability', () => {
  it('normalizes AI SDK usage and OpenRouter cost metadata', () => {
    expect(modelUsageFromAiSdk({
      usage: { inputTokens: { total: 120 }, outputTokens: { total: 40 } },
      response: { id: 'request-1' },
      providerMetadata: { openrouter: { usage: { cost: 0.012 } } },
    })).toEqual({ inputTokens: 120, outputTokens: 40, costUsd: 0.012, requestId: 'request-1' });
  });

  it('reuses a successful tool result instead of repeating an external action', async () => {
    let toolRow: { status: string; output_json: string } | null = null;
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes('from agent_runs')) return { id: 'run-1' };
            if (sql.includes('from agent_tool_calls')) return toolRow;
            return null;
          },
          run: async () => {
            if (sql.startsWith('insert into agent_tool_calls')) toolRow = { status: 'running', output_json: '{}' };
            if (sql.includes("set status = 'succeeded'")) toolRow = { status: 'succeeded', output_json: String(args[0]) };
            return { meta: { changes: 1 } };
          },
        }),
      })),
    };
    const execute = vi.fn(async () => ({ value: 'external-result' }));
    const input = { runId: 'run-1', key: 'search:1', name: 'search_web', capability: 'external' };
    await expect(traceRuntimeTool(db as never, input, execute)).resolves.toEqual({ value: 'external-result' });
    await expect(traceRuntimeTool(db as never, input, execute)).resolves.toEqual({ value: 'external-result' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('replays a projected model result without another provider call and repairs usage totals', async () => {
    const fixture = modelDb();
    const execute = vi.fn(async () => ({ value: 'stable', prompt: 'must-not-be-persisted' }));
    const input = {
      runId: 'run-1', turn: 1, provider: 'openrouter', model: 'test',
      usage: () => ({ inputTokens: 12, outputTokens: 4 }),
    };
    await expect(traceRuntimeModelValue(fixture.db as never, input, async () => {
      const value = await execute();
      return { value: value.value };
    })).resolves.toEqual({ value: 'stable' });
    await expect(traceRuntimeModelValue(fixture.db as never, input, execute as never)).resolves.toEqual({ value: 'stable' });
    expect(execute).toHaveBeenCalledOnce();
    expect(fixture.aggregateCalls()).toBe(2);
    expect(fixture.row()?.result_json).toBe('{"value":"stable"}');
  });

  it('preserves ordinary for-slugs while redacting actual provider-shaped secrets', async () => {
    const fixture = modelDb();
    const value = { topic_key: 'best-app-for-research', credential: 'sk-or-v1-abcdefghijklmnop' };
    await traceRuntimeModelValue(fixture.db as never, {
      runId: 'run-1', turn: 3, provider: 'openrouter', model: 'test',
    }, async () => value);
    expect(JSON.parse(fixture.row()!.result_json)).toEqual({ topic_key: 'best-app-for-research', credential: '[redacted]' });
  });

  it('does not treat a failed model call as a replayable success', async () => {
    const fixture = modelDb();
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ value: 'recovered' });
    const input = { runId: 'run-1', turn: 2, provider: 'openrouter', model: 'test' };
    await expect(traceRuntimeModelValue(fixture.db as never, input, execute)).rejects.toThrow('provider unavailable');
    await expect(traceRuntimeModelValue(fixture.db as never, input, execute)).resolves.toEqual({ value: 'recovered' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('accounts for token usage and request identity from a failed provider response', async () => {
    const fixture = modelDb();
    const error = Object.assign(new Error('empty provider response'), {
      modelCallMeta: {
        inputTokens: 34, outputTokens: 120, costUsd: 0.008, requestId: 'generation-empty',
      },
    });
    await expect(traceRuntimeModelValue(fixture.db as never, {
      runId: 'run-1', turn: 4, provider: 'openrouter', model: 'test-model',
    }, async () => { throw error; })).rejects.toThrow('empty provider response');
    expect(fixture.lastModelArgs().slice(5, 8)).toEqual([34, 120, 0.008]);
    expect(fixture.lastModelArgs()[9]).toBe('generation-empty');
    expect(fixture.aggregateSql()).not.toContain("status = 'succeeded'");
  });

  it('preserves completion diagnostics and usage when semantic projection rejects a provider success', async () => {
    const fixture = modelDb();
    const raw = {
      finishReason: { unified: 'length', raw: 'length' },
      steps: [{ toolCalls: [] }],
      text: 'partial reasoning',
      usage: { inputTokens: { total: 4000 }, outputTokens: { total: 2500 } },
      response: { id: 'generation-truncated' },
    };
    let thrown: unknown;
    try {
      await traceRuntimeModel(fixture.db as never, {
        runId: 'run-1', turn: 5, provider: 'openrouter', model: 'test-model',
        usage: modelUsageFromAiSdk,
        result: () => { throw new Error('Content production decision must return exactly one tool call; received 0'); },
      }, async () => raw);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { modelCallMeta?: unknown }).modelCallMeta).toEqual({
      inputTokens: 4000, outputTokens: 2500, costUsd: 0, requestId: 'generation-truncated', finishReason: 'length',
    });
    expect(fixture.lastModelArgs().slice(5, 8)).toEqual([4000, 2500, 0]);
    expect(JSON.parse(fixture.row()!.result_json)).toEqual({
      completion: { finish_reason: 'length', tool_call_count: 0, text_length: 17 },
    });
  });

  it('closes orphaned running tool calls when the Workflow fails outside tool code', async () => {
    let statement = '';
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: () => ({ run: async () => { statement = sql; return { meta: { changes: 1 } }; } }),
      })),
    };
    await failRunningRuntimeTools(db as never, 'run-1', new Error('workflow internal failure'));
    expect(statement).toContain("set status = 'failed'");
    expect(statement).toContain("where run_id = ? and status = 'running'");
  });
});
