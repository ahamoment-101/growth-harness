import { getSite } from '../../db';
import { startRuntimeRun } from '../../agent-runtime/run-service';
import { publicStrategyError } from './error';
import { runningStrategyRun } from './strategy-store';
import { CONSOLE_STRATEGY_REQUEST } from '../../agent-runtime/strategy-request-instructions';
import { recordTopicResearchDispatch, undispatchedTopicResearchRequests, unfinishedStrategyTask } from '../../agent-runtime/topic-decision-store';

/** A strategy task serves a request; the agent decides the work from its content, not from its source. */
export type StrategyRequest = { requester: Record<string, unknown>; message: string; context?: Record<string, unknown> };

export async function startStrategyResearch(
  env: Env,
  siteId: string,
  trigger: 'manual',
  sourceLocale: string,
  request: StrategyRequest = CONSOLE_STRATEGY_REQUEST,
  runId?: string,
): Promise<{ runId: string } | { error: string; status: number }> {
  if (env.AGENT_RUNTIME_ENABLED !== 'true') return { error: 'Agent Runtime is disabled', status: 503 };
  return startStrategyResearchRuntime(env, siteId, trigger, sourceLocale, request, runId);
}

async function startStrategyResearchRuntime(
  env: Env,
  siteId: string,
  trigger: 'manual',
  sourceLocale: string,
  request: StrategyRequest,
  runId?: string,
): Promise<{ runId: string } | { error: string; status: number }> {
  const site = await getSite(env.DB, siteId);
  if (!site) return { error: 'site not found', status: 404 };
  const configuredLocales = [site.source_locale, ...JSON.parse(site.translate_locales_json || '[]') as string[]];
  if (!configuredLocales.includes(sourceLocale)) return { error: 'Strategy research language is not among the languages enabled for the project', status: 400 };
  const legacyRunning = await runningStrategyRun(env.DB, site.id, sourceLocale);
  if (legacyRunning) return { error: 'Strategy research is in progress', status: 409 };
  try {
    const run = await startRuntimeRun(env, {
      workspaceId: site.workspace_id, siteId: site.id, agentId: 'strategy_research', trigger,
      instanceId: `strategy:${sourceLocale}`, ...(runId ? { runId } : {}),
      summary: { runtime: 'strategy_research_agentic_v3', locale: sourceLocale, request },
    });
    return { runId: run.id };
  } catch (error) {
    const message = publicStrategyError(error);
    return { error: message, status: /already.*running|\u5df2\u7ecf.*\u8fd0\u884c/i.test(message) ? 409 : 500 };
  }
}

/**
 * Starts strategy research for topic research requests. Runs from the scheduled handler because an
 * executing task may only start its own children, and a topic task ends without waiting for research.
 */
export async function dispatchTopicResearchRequests(env: Env): Promise<void> {
  if (env.AGENT_RUNTIME_ENABLED !== 'true') return;
  for (const row of await undispatchedTopicResearchRequests(env.DB)) {
    try {
      if (await unfinishedStrategyTask(env.DB, row.workspace_id, row.site_id, row.scope_locale)) continue;
      const research = JSON.parse(row.research_request_json || '{}') as Record<string, unknown>;
      const started = await startStrategyResearch(env, row.site_id, 'manual', row.scope_locale, {
        requester: { type: 'agent', agent_id: 'topic_decision', task_id: row.run_id, research_request_id: row.id },
        message: `Topic decisions for language ${row.scope_locale} cannot form a responsible topic group and request research: ${String(research.gap || row.rationale)}`,
        context: { rationale: row.rationale, ...research },
      }, `topic-research-${row.id}`);
      // A missing site or a language no longer enabled will not change by retrying; a busy
      // language or a transient start failure keeps the request pending for the next minute.
      if ('error' in started) { if ([400, 404].includes(started.status)) await recordTopicResearchDispatch(env.DB, row.id, { error: started.error }); continue; }
      await recordTopicResearchDispatch(env.DB, row.id, { runId: started.runId });
    } catch (error) {
      console.error('Topic research dispatch failed', row.id, error);
    }
  }
}
