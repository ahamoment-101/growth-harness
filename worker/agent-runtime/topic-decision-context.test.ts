import { describe, expect, it } from 'vitest';
import { agentDefinition } from './definitions';
import type { AgentRun } from './protocol';
import { loadTopicDecisionContext } from './topic-decision-context';

const DEFINITION = agentDefinition('topic_decision');
const run = (summary: Record<string, unknown>) => ({
  id: 'run-current', workspace_id: 'workspace-1', site_id: 'site-1', agent_id: 'topic_decision',
  trigger: 'manual', summary_json: JSON.stringify(summary), created_at: '2026-09-02T00:00:00Z',
}) as unknown as AgentRun;

describe('topic decision initial materials', () => {
  it('binds the initial context to the task language', async () => {
    const sources = await loadTopicDecisionContext({} as never, {}, run({ group_size: 4, locales: ['pt-BR'], scope: { locale: 'pt-BR' } }));
    expect(sources.map(source => source.sourceId).sort()).toEqual([...DEFINITION.contextSources].sort());
    expect(sources.find(source => source.sourceId === 'run_constraints')!.value).toMatchObject({
      requested_count: 4, source_locale: 'pt-BR', locales: ['pt-BR'], keyword_source: 'keyword_library_only',
    });
  });

  it('refuses a task without a language', async () => {
    await expect(loadTopicDecisionContext({} as never, {}, run({ group_size: 10, locales: ['en', 'pt-BR'] }))).rejects.toThrow('language');
  });
});
