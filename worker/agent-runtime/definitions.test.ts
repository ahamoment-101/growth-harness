import { describe, expect, it } from 'vitest';
import { AGENT_IDS, agentDefinition, agentRoster, assertAgentDefinition, isAgentId, parseRuntimeAgentName, runtimeAgentName } from './definitions';

describe('agent runtime definitions', () => {
  it('injects different context tools for different agent ids', () => {
    expect(agentDefinition('runtime_synthetic').injectedTool).toBe('read_synthetic_context');
    expect(agentDefinition('strategy_research').injectedTool).toBeNull();
    expect(agentDefinition('strategy_research').definitionVersion).toBe(44);
    expect(agentDefinition('strategy_research').runPolicy.allowScheduled).toBe(false);
    expect(agentDefinition('strategy_research').parameterContractVersion).toBe(2);
    expect(agentDefinition('strategy_research').promptVersion).toBe('strategy-library-v15-language-english-v2');
    expect(agentDefinition('strategy_research').tools).toContain('research_keywords');
    expect(agentDefinition('keyword_research').tools).toContain('create_library_keyword');
    expect(agentDefinition('keyword_research').tools).toContain('finish_keyword_research');
    expect(agentDefinition('keyword_research').tools).not.toContain('deep_research');
    expect(agentDefinition('keyword_research').runPolicy).toMatchObject({ allowSubAgents: false, allowApprovals: false, allowScheduled: false });
    expect(agentDefinition('strategy_research').tools).toContain('restore_strategy_reports');
    expect(agentDefinition('strategy_research').tools).toContain('deep_research');
    // Both research tools are available: a shallow lookup and a full research
    // task answer different questions, and the prompt says which to reach for.
    expect(agentDefinition('strategy_research').tools).toContain('strategy_search_web');
    expect(() => assertAgentDefinition(agentDefinition('strategy_research'))).not.toThrow();
    expect(agentDefinition('topic_decision').definitionVersion).toBe(28);
    expect(agentDefinition('topic_decision').promptVersion).toBe('topic-decision-library-v19-language-english-v2');
    expect(agentDefinition('content_production').tools).toEqual([
      'save_coverage_plan', 'inspect_content_group', 'read_content_article', 'read_published_articles', 'edit_article_internal_links', 'start_article_tasks', 'start_content_reviews',
      'complete_content_group', 'defer_content_group', 'request_human_input',
    ]);
    expect(agentDefinition('content_production').definitionVersion).toBe(27);
    expect(agentDefinition('content_production').promptVersion).toBe('content-production-agent-loop-v21-immutable-publication-english-v2');
    expect(agentDefinition('article_production').definitionVersion).toBe(25);
    expect(agentDefinition('article_production').promptVersion).toBe('article-production-agent-loop-v19-editorial-readiness');
    expect(agentDefinition('article_production').tools).toEqual(['read_article_source', 'save_claim_evidence', 'read_published_articles', 'article_search_web', 'find_link_targets', 'submit_article', 'save_article_draft', 'run_self_check', 'deliver_article', 'defer_article', 'request_human_input']);
    expect(agentDefinition('content_review').tools).toEqual(['read_article_source', 'submit_content_review', 'defer_content_review', 'request_human_input']);
    expect(agentDefinition('content_review').definitionVersion).toBe(17);
    expect(agentDefinition('content_review').runPolicy.allowSubAgents).toBe(false);
    expect(agentDefinition('content_production').runPolicy.maxActiveChildren).toBe(20);
    for (const id of ['growth_leader', 'business_research', 'strategy_research', 'keyword_research', 'topic_decision', 'content_production', 'article_production', 'content_review'] as const) {
      const definition = agentDefinition(id);
      expect(definition.tools).toContain('request_human_input');
      expect(definition.hitlSinceVersion).toBeGreaterThan(0);
    }
    for (const id of ['strategy_research', 'keyword_research', 'business_research', 'topic_decision', 'content_production', 'article_production', 'content_review'] as const) {
      const definition = agentDefinition(id);
      expect(definition.taskBased).toBe(true);
      expect(definition).not.toHaveProperty('stagePolicy');
      expect(definition).not.toHaveProperty('continuationPolicy');
      expect(definition).not.toHaveProperty('observationPolicy');
      expect(definition.runPolicy).not.toHaveProperty('maxModelCalls');
      expect(definition.runPolicy).not.toHaveProperty('maxTotalTokens');
    }
  });

  it('presents each team member once, in registry order, and keeps system Agents internal', () => {
    const roster = agentRoster();
    expect(roster.map((m) => m.agentId)).toEqual(AGENT_IDS.filter((id) => agentDefinition(id).presence.kind === 'staff'));
    expect(roster.map((m) => m.name)).toEqual(['Strategist', 'Deep Researcher', 'Keyword Researcher', 'Topic Editor', 'Editor-in-Chief', 'Writer', 'Reviewer']);
    expect(new Set(roster.map((m) => m.name)).size).toBe(roster.length);
    for (const id of ['runtime_synthetic', 'runtime_synthetic_child', 'business_research'] as const) {
      expect(agentDefinition(id).presence.kind).toBe('internal');
    }
    for (const id of AGENT_IDS) expect(() => assertAgentDefinition(agentDefinition(id))).not.toThrow();
  });

  it('rejects a team member without a name or mission, and a hidden Agent without a reason', () => {
    const base = agentDefinition('article_production');
    expect(() => assertAgentDefinition({ ...base, presence: { kind: 'staff', name: ' ', mission: 'x' } })).toThrow();
    expect(() => assertAgentDefinition({ ...base, presence: { kind: 'staff', name: 'Writer', mission: '' } })).toThrow();
    expect(() => assertAgentDefinition({ ...base, presence: { kind: 'internal', reason: '' } })).toThrow();
  });

  it('keeps one durable identity per site, definition, and optional task instance', () => {
    expect(runtimeAgentName('workspace-1', 'site-1', 'runtime_synthetic')).toBe('workspace-1--site-1--runtime_synthetic');
    expect(runtimeAgentName('workspace-1', 'site-1', 'strategy_research')).not.toBe(runtimeAgentName('workspace-1', 'site-1', 'runtime_synthetic'));
    expect(parseRuntimeAgentName('workspace-1--site%2Fone--strategy_research')).toEqual({ workspaceId: 'workspace-1', siteId: 'site/one', agentId: 'strategy_research', instanceId: '' });
    const child = runtimeAgentName('workspace-1', 'site-1', 'article_production', 'decision-item-1');
    expect(parseRuntimeAgentName(child)).toEqual({ workspaceId: 'workspace-1', siteId: 'site-1', agentId: 'article_production', instanceId: 'decision-item-1' });
    expect(child).not.toBe(runtimeAgentName('workspace-1', 'site-1', 'article_production', 'decision-item-2'));
    expect(parseRuntimeAgentName('workspace-1--site-1--writer')).toBeNull();
  });

  it('rejects unknown router ids', () => {
    expect(isAgentId('runtime_synthetic')).toBe(true);
    expect(isAgentId('content_production')).toBe(true);
    expect(isAgentId('article_production')).toBe(true);
    expect(isAgentId('content_review')).toBe(true);
    expect(isAgentId('writer')).toBe(false);
  });

  it('rejects definition drift inputs, malformed outputs, and unknown tools before execution', () => {
    const definition = agentDefinition('strategy_research');
    expect(() => definition.inputSchema.parse({ runId: '', workspaceId: 'w', siteId: 's', agentId: 'strategy_research' })).toThrow();
    expect(() => definition.outputSchema.parse({ strategy_version: 1 })).toThrow();
    expect(() => assertAgentDefinition({ ...definition, tools: [...definition.tools, 'unknown_runtime_tool'] })).not.toThrow();
  });
});
