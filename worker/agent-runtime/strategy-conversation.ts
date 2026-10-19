import { STRATEGY_DIRECTION_SLOT_INSTRUCTIONS, STRATEGY_DRAFT_SLOT_INSTRUCTIONS, STRATEGY_SLOT_INSTRUCTIONS } from './strategy-slots';
import { STRATEGY_KEYWORD_DELEGATION_INSTRUCTIONS } from './library-business-instructions';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { agentDefinition } from './definitions';
import { runConversationTask, type ConversationAgent } from './conversation-runtime';
import { STRATEGY_DIRECTION_TASK_SYSTEM, STRATEGY_DRAFT_TASK_SYSTEM, STRATEGY_TASK_SYSTEM, strategyTaskTools } from './strategy-task';
import { activeStrategyVersion, getStrategyRun } from '../lib/research/strategy-store';
import { getSiteForWorkspace } from '../db';
import { loadStrategyResearchContext } from './strategy-context';
import { strategyBaseline } from './strategy-baseline';
import { taskForRun } from './task-store';
import { taskDecisionTurns } from './conversation-store';
import { strategyReportDelivery } from '../lib/research/report-delivery';
import { STRATEGY_REQUEST_COMPLETION, strategyRequestInstructions } from './strategy-request-instructions';

type Input = { env: RuntimeAgentEnv; step: RuntimeWorkflowStep; runId: string;
  transport?: { model: Model<Api>; stream: StreamFn } };

/** Instructions are pinned when a task's conversation starts; older definitions keep their own text. */
export function strategyInstructions(definitionVersion: number, parameterContractVersion: number): string {
  const slots = [1, 2].includes(parameterContractVersion);
  if (definitionVersion < 34) return slots ? STRATEGY_TASK_SYSTEM + '\n' + STRATEGY_SLOT_INSTRUCTIONS : STRATEGY_TASK_SYSTEM;
  if (definitionVersion >= 39) return strategyRequestInstructions(slots) + '\nWhen a decision-critical business fact is absent from the available records and further autonomous work cannot resolve it, use request_human_input to compose a concise, specific inline request. Complete independent work first. The response is information for your next decision; the actions do not grant publication or other business authority.';
  if (definitionVersion >= 38) return strategyRequestInstructions(slots);
  if (definitionVersion >= 36) return (slots ? STRATEGY_DRAFT_TASK_SYSTEM + '\n' + STRATEGY_DRAFT_SLOT_INSTRUCTIONS : STRATEGY_DRAFT_TASK_SYSTEM)
    + '\n' + STRATEGY_KEYWORD_DELEGATION_INSTRUCTIONS;
  return (slots ? STRATEGY_DIRECTION_TASK_SYSTEM + '\n' + STRATEGY_DIRECTION_SLOT_INSTRUCTIONS : STRATEGY_DIRECTION_TASK_SYSTEM)
    + '\n' + STRATEGY_KEYWORD_DELEGATION_INSTRUCTIONS;
}

export async function runStrategyConversation(input: Input) {
  const { env, runId } = input;
  const definition = agentDefinition('strategy_research');
  const businessRun = await getStrategyRun(env.DB, runId);
  if (!businessRun?.source_locale) throw new Error('Strategy task locale missing');
  const locale = businessRun.source_locale;
  const boundTask = await taskForRun(env.DB, runId);
  const agent: ConversationAgent = {
    auditCompletionTools: ['submit_strategy'],
    instructions: strategyInstructions(boundTask?.definition_version || 0, boundTask?.parameter_contract_version || 0),
    context: async task => {
      const site = await getSiteForWorkspace(env.DB, task.workspace_id, task.site_id);
      if (!site) throw new Error('Strategy site missing');
      const baseVersionId = (await activeStrategyVersion(env.DB, site.id, locale))?.id || '';
      const baseline = await strategyBaseline(env.DB, task, locale, baseVersionId);
      // From v34 concrete keywords live only in the library; an inherited draft keyword list is not carried forward.
      if (task.definition_version >= 34) baseline.workspace.keywords = [];
      if ([1, 2].includes(task.parameter_contract_version || 0)) baseline.workspace.keywords = baseline.workspace.keywords.map(keyword => ({ ...keyword, id: keyword.id || crypto.randomUUID() }));
      return { goal: JSON.parse(task.goal_json), locale, task_id: task.id, revision: task.revision,
        base_strategy_version_id: baseVersionId, draft_origin: baseline.origin,
        ...((task.definition_version || 0) >= 29 ? { report_delivery: await strategyReportDelivery(env.DB, site.id, locale, baseVersionId) } : {}),
        available_materials: { site_content: 'read_site_content', strategy_versions: 'read_strategy', research_archive: 'read_evidence' },
        sources: await loadStrategyResearchContext(env.DB, site, runId, locale, baseVersionId), workspace: baseline.workspace };
    },
    initialWorkspace: context => (context as { workspace: unknown }).workspace,
    tools: (task, operation) => strategyTaskTools({ ...input, definition, task, operation, locale }),
    completionInstructions: (boundTask?.definition_version || 0) >= 38 ? STRATEGY_REQUEST_COMPLETION : (boundTask?.definition_version || 0) >= 30
      ? 'Carry out the requested research and submit the next strategy version, even when existing recommendations remain applicable. Finish after submission, or wait/pause for a concrete blocker. A text response or restoration of old reports does not deliver the requested new version.'
      : 'The strategy task has no committed outcome yet. Continue any useful research or draft revision, submit a ready strategy, or use finish_strategy to express no_change, waiting or paused. A text response alone does not save a strategy version.',
  };
  const result = await runConversationTask({ ...input, definition, agent });
  const task = (await taskForRun(env.DB, runId))!;
  return { output: { outcome: result.status === 'completed' ? result.outcome : result.status,
    task_id: task.id, strategy_version: 0, territories: 0, clusters: 0, keywords: 0, web_sources: 0,
    ...result.output as Record<string, unknown>, decision_turns: await taskDecisionTurns(env.DB, task), reason: result.reason },
    phase: result.status === 'completed' ? result.outcome : 'deferred' };
}
