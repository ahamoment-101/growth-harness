import { topicScope } from './topic-scope';
import type { D1Database } from '@cloudflare/workers-types';
import type { ContextSourceValue } from './context';
import { topicDecisionSummary } from './topic-decision-store';
import type { AgentRun } from './protocol';

/**
 * Every topic decision is bound to exactly one language. Business, strategy,
 * history and inventory observations are read on demand through read_topic_context.
 */
export async function loadTopicDecisionContext(
  _db: D1Database,
  _site: unknown,
  run: AgentRun,
): Promise<ContextSourceValue[]> {
  const scope = topicScope(run.summary_json);
  if (!scope) throw new Error('Topic decision requires a language');
  return [{
    sourceId: 'run_constraints', version: run.id, capturedAt: run.created_at, priority: 100,
    value: { requested_count: topicDecisionSummary(run).groupSize, source_locale: scope.locale, locales: [scope.locale], scope, trigger: run.trigger, keyword_source: 'keyword_library_only' },
  }, { sourceId: 'active_strategies', version: 'on-demand', capturedAt: run.created_at, priority: 50,
    value: [{ locale: scope.locale, version: { id: null, version: 0 }, keywords: [], observation: 'Use read_topic_context for optional strategy background. No strategy is required to read library candidates.' }],
  }];
}
