import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentDefinition } from './definitions';
import { runtimeAgentModule } from './agent-modules';
import { ToolRegistry } from './tools';

describe('Agent Tool Registry', () => {
  it('enforces definition allowlists and schemas', async () => {
    const registry = new ToolRegistry().register({
      name: 'read_synthetic_context', version: 1, description: 'fixture', capability: 'read',
      inputSchema: z.object({ key: z.string() }), outputSchema: z.object({ ok: z.boolean() }),
      timeoutMs: 100, retryable: false, approval: 'never', execute: async () => ({ ok: true }),
    });
    const context = { runId: 'r', workspaceId: 'w', siteId: 's', idempotencyKey: 'r:1' };
    await expect(registry.execute(agentDefinition('runtime_synthetic'), 'read_synthetic_context', { key: 'x' }, context)).resolves.toEqual({ ok: true });
    await expect(registry.execute(agentDefinition('runtime_synthetic'), 'read_synthetic_context', {}, context)).rejects.toThrow();
    expect(() => registry.resolve(agentDefinition('strategy_research'), 'read_synthetic_context')).toThrow(/not allowed/);
  });

  it('requires approval for destructive tools', () => {
    expect(() => new ToolRegistry().register({
      name: 'delete_data', version: 1, description: 'bad', capability: 'destructive',
      inputSchema: z.object({}), outputSchema: z.object({}), timeoutMs: 100,
      retryable: false, approval: 'never', execute: async () => ({}),
    })).toThrow(/require approval/);
  });

  it('rejects aliases, invalid outputs, and execution past the declared timeout', async () => {
    expect(() => new ToolRegistry().register({
      name: 'Search_Web', version: 1, description: 'alias', capability: 'external',
      inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }), timeoutMs: 10,
      retryable: true, approval: 'never', execute: async () => ({ ok: true }),
    })).toThrow(/identity/);

    const definition = agentDefinition('runtime_synthetic');
    const context = { runId: 'r', workspaceId: 'w', siteId: 's', idempotencyKey: 'r:timeout' };
    const invalidOutput = new ToolRegistry().register({
      name: 'read_synthetic_context', version: 1, description: 'invalid output', capability: 'read',
      inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }), timeoutMs: 100,
      retryable: false, approval: 'never', execute: async () => ({ ok: 'wrong' } as never),
    });
    await expect(invalidOutput.execute(definition, 'read_synthetic_context', {}, context)).rejects.toThrow();

    const timed = new ToolRegistry().register({
      name: 'read_synthetic_context', version: 1, description: 'timeout', capability: 'read',
      inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }), timeoutMs: 5,
      retryable: true, approval: 'never', execute: async () => new Promise(() => {}),
    });
    await expect(timed.execute(definition, 'read_synthetic_context', {}, context)).rejects.toThrow(/timed out/);
  });

  it('redacts sensitive result fields after output validation', async () => {
    const registry = new ToolRegistry().register({
      name: 'read_synthetic_context', version: 1, description: 'redaction', capability: 'read',
      inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean(), api_key: z.string(), note: z.string() }),
      timeoutMs: 100, retryable: false, approval: 'never',
      execute: async () => ({ ok: true, api_key: 'sk-or-private-value', note: 'safe' }),
    });
    await expect(registry.execute(agentDefinition('runtime_synthetic'), 'read_synthetic_context', {}, {
      runId: 'r', workspaceId: 'w', siteId: 's', idempotencyKey: 'r:redact',
    })).resolves.toEqual({ ok: true, api_key: '[redacted]', note: 'safe' });
  });

  it('preserves full-size output only when a bounded tool explicitly opts in', async () => {
    const content = 'a'.repeat(5000);
    const registry = new ToolRegistry().register({
      name: 'read_full_document', version: 1, description: 'read', capability: 'read',
      inputSchema: z.object({}), outputSchema: z.object({ content: z.string() }),
      timeoutMs: 100, retryable: true, approval: 'never', preserveOutputSize: true,
      execute: async () => ({ content }),
    });
    const definition = { ...agentDefinition('runtime_synthetic'), tools: ['read_full_document'] };
    await expect(registry.execute(definition, 'read_full_document', {}, {
      runId: 'r', workspaceId: 'w', siteId: 's', idempotencyKey: 'r:full',
    })).resolves.toEqual({ content });
  });

  it('keeps the research capability and schema stable after successful calls', () => {
    const definition = agentDefinition('topic_decision');
    const registry = runtimeAgentModule('topic_decision').createToolRegistry!({} as never);
    expect(registry.resolve(definition, 'topic_search_web').inputSchema).toBeDefined();
    expect(registry.resolve(definition, 'read_published_articles').inputSchema).toBeDefined();
  });
});
