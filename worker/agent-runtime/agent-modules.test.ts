// @ts-ignore Vitest executes this architecture test in Node; Worker sources intentionally omit Node types.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_IDS } from './definitions';
import { registeredRuntimeAgentModules } from './agent-modules';

describe('Runtime Agent module architecture', () => {
  it('registers every definition and resolves every model-visible tool from one Runtime registry', () => {
    const modules = registeredRuntimeAgentModules();
    expect(modules.map((module) => module.definition.id).sort()).toEqual([...AGENT_IDS].sort());
    for (const module of modules) {
      if (!module.createToolRegistry) continue;
      const registry = module.createToolRegistry({} as never);
      for (const name of module.definition.tools) expect(() => registry.resolve(module.definition, name)).not.toThrow();
    }
  });

  it('keeps provider clients and duplicated planner tools out of business Agent loops', () => {
    // @ts-ignore Vitest provides import.meta.url; Worker compilation intentionally omits Node globals.
    const directory = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
    for (const file of [
      'strategy-conversation.ts', 'topic-conversation.ts', 'content-parent-conversation.ts',
      'content-conversations.ts', 'business-research.ts',
    ]) {
      const source = readFileSync(`${directory}/${file}`, 'utf8');
      expect(source).not.toMatch(/\bgenerate(?:Text|Object)\b/);
      expect(source).not.toContain('createOpenRouter');
      expect(source).not.toContain('createOpenAICompatible');
      expect(source).not.toContain('plannerTools');
      expect(source).toContain('runConversationTask');
      if (file === 'strategy-conversation.ts') expect(source).not.toContain('runTaskLoop');
    }
  });

  it('keeps business Agent branching out of generic run and Workflow services', () => {
    // @ts-ignore Vitest provides import.meta.url; Worker compilation intentionally omits Node globals.
    const directory = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
    for (const file of ['run-service.ts', 'durable-workflow.ts']) {
      const source = readFileSync(`${directory}/${file}`, 'utf8');
      expect(source).not.toMatch(/agentId\s*===\s*['"](?:strategy_research|topic_decision|content_production|article_production|content_review)/);
      expect(source).not.toMatch(/switch\s*\([^)]*agent/i);
    }
  });

  it('binds every business decision to one resolved model profile without fallback', () => {
    // @ts-ignore Vitest provides import.meta.url; Worker compilation intentionally omits Node globals.
    const directory = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
    const gateway = readFileSync(`${directory}/conversation-runtime.ts`, 'utf8');
    const policy = readFileSync(`${directory}/model-policy.ts`, 'utf8');
    expect(gateway).not.toContain('models: string[]');
    expect(gateway).not.toContain('input.models');
    expect(policy).not.toContain('runtimeModelCandidates');
    expect(policy).not.toContain('fallbackIndex');
    expect(gateway).toContain('resolveModelProfile');
  });
});
