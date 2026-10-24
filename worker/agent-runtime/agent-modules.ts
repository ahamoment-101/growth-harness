import { learningTools, runLearningAgent } from '../learning/agent';
import { runLeaderConversation } from '../growth-leader/runtime';
import { createConversation, settleLeaderCheckpoint, wakeConversation } from '../growth-leader/service';
import { dispatchPendingAgentEvents, publicationConversationId } from '../agent-events/pool';
import type { RuntimeExecutionContext } from './execution-context';
import { scopedTopicSummary, topicScope, topicInstance } from './topic-scope';
import { runTopicConversation } from './topic-conversation';
import { runArticleConversation, runReviewConversation } from './content-conversations';
import { runContentParentConversation } from './content-parent-conversation';
import { businessResearchTools, runBusinessResearch } from './business-research';
import { runFirecrawlResearch, cancelFirecrawlResearch } from './firecrawl-research';
import { keywordResearchTaskSchema, keywordResearchTools, runKeywordResearchConversation } from './keyword-research';
import { runRecoveryProbe } from './recovery-probe';
import { resolveModelProfile } from './model-registry';
import { researchBriefSchema } from './research-contract';
import { strategyTaskTools } from './strategy-task';
import { runStrategyConversation } from './strategy-conversation';
import { stopTask, taskForRun } from './task-store';
import type { AgentDefinition, AgentId } from './definitions';
import { agentDefinition } from './definitions';
import type { RuntimeAgentEnv } from './env';
import type { ContextSourceValue } from './context';
import type { RuntimeWorkflowStep } from './env';
import type { AgentRun } from './protocol';
import type { StartRuntimeRunInput } from './run-service';
import { ToolRegistry } from './tools';
import { hitlTool } from '../agent-work/hitl-tool';
import { createTopicDecisionToolRegistry } from './topic-decision-tools';
import { createContentProductionToolRegistry } from './content-production-tools';
import { createArticleProductionToolRegistry } from './article-production-tools';
import { createContentReviewToolRegistry } from './content-review-tools';
import { loadStrategyResearchContext } from './strategy-context';
import { loadTopicDecisionContext } from './topic-decision-context';
import {
  loadArticleProductionContext,
  loadContentProductionContext,
  loadContentReviewContext,
  markContentGroupAttention,
  recordContentReviewInteraction,
} from './content-production';
import { appendAgentEvent, getAgentRun } from './store';
import { appendEvidenceMemory } from './memory';
import { runtimeJson } from './protocol';
import { publicStrategyError } from '../lib/research/error';
import { getStrategyRun, insertStrategyRun, runningStrategyRun, updateStrategyRun } from '../lib/research/strategy-store';

export type AgentModuleExecutionContext = {
  env: RuntimeAgentEnv;
  step: RuntimeWorkflowStep;
  definition: AgentDefinition;
  run: AgentRun;
  values: Record<string, unknown>;
  snapshotId: string;
  scenario: string;
  startChildRun: (request: StartRuntimeRunInput) => Promise<{ id: string }>;
  waitForApproval: () => Promise<void>;
  waitForInput: () => Promise<void>;
};

export type AgentModuleExecution = { output: unknown; phase: string };

export type RuntimeAgentModule = {
  definition: AgentDefinition;
  settleCheckpoint?: (env: RuntimeAgentEnv, authority: RuntimeExecutionContext) => Promise<unknown>;
  afterCheckpoint?: (env: RuntimeAgentEnv, authority: RuntimeExecutionContext) => Promise<void>;
  wakeForEvent?: (env: RuntimeAgentEnv, target: {workspaceId:string;siteId:string;targetRunId:string}) => Promise<void>;
  parentAgentIds?: readonly AgentId[];
  manualStartAllowed?: boolean;
  requiresHubPath?: boolean;
  validateStart?: (env: RuntimeAgentEnv, input: StartRuntimeRunInput, site: Record<string, unknown>) => Promise<void>;
  findBlockingBusinessRun?: (env: RuntimeAgentEnv, input: StartRuntimeRunInput) => Promise<{ id: string } | null>;
  businessRunExists?: (env: RuntimeAgentEnv, runId: string) => Promise<boolean>;
  initializeBusinessRun?: (env: RuntimeAgentEnv, input: StartRuntimeRunInput, runId: string) => Promise<void>;
  failBusinessStart?: (env: RuntimeAgentEnv, runId: string, message: string) => Promise<void>;
  createToolRegistry?: (env: RuntimeAgentEnv) => ToolRegistry;
  loadContext: (env: RuntimeAgentEnv, site: Record<string, unknown>, run: AgentRun) => Promise<ContextSourceValue[]>;
  execute: (context: AgentModuleExecutionContext) => Promise<AgentModuleExecution>;
  publicError?: (error: unknown) => string;
  onCancel?: (env: RuntimeAgentEnv, run: AgentRun) => Promise<void>;
  onFailure?: (env: RuntimeAgentEnv, run: AgentRun, message: string) => Promise<void>;
};


const syntheticModule = (id: 'runtime_synthetic' | 'runtime_synthetic_child'): RuntimeAgentModule => ({
  definition: agentDefinition(id),
  loadContext: async () => [{
    sourceId: 'synthetic_fixture', version: '1', capturedAt: '', priority: 100,
    value: { fixture: 'durable-runtime-verification' },
  }],
  execute: async (context) => {
    if (context.scenario === 'recovery_reconcile') {
      const { reconcileTaskExecutions } = await import('./task-recovery');
      await reconcileTaskExecutions(context.env);
    }
    if (context.scenario === 'recovery') return runRecoveryProbe(context);
    if (context.scenario === 'approval') await context.waitForApproval();
    if (context.scenario === 'input') await context.waitForInput();
    if (context.scenario === 'slow') await context.step.sleep('wait-for-cancel-verification', '5 minutes');
    if (['child', 'child_cancel'].includes(context.scenario) && id === 'runtime_synthetic') {
      const childId = `child-${context.run.id}`;
      await context.step.do('start-synthetic-child-agent', async () => context.startChildRun({
        runId: childId, workspaceId: context.run.workspace_id, siteId: context.run.site_id,
        agentId: 'runtime_synthetic_child', trigger: 'sub_agent', parentRunId: context.run.id,
        summary: { scenario: context.scenario === 'child_cancel' ? 'slow' : 'default' },
      }));
      let status = 'queued';
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        status = await context.step.do(`check-synthetic-child-${attempt}`, async () => (
          await getAgentRun(context.env.DB, childId)
        )?.status || 'missing');
        if (status === 'succeeded') break;
        if (['failed', 'cancelled', 'missing'].includes(status)) throw new Error(`Synthetic child Agent ended as ${status}`);
        await context.step.sleep(`wait-synthetic-child-${attempt}`, '1 second');
      }
      if (status !== 'succeeded') throw new Error('Synthetic child Agent did not complete before timeout');
    }
    const event = await context.step.do('synthetic-durable-action', async () => appendAgentEvent(context.env.DB, {
      runId: context.run.id, eventKey: 'synthetic.verified', kind: 'tool_completed', phase: 'verifying_durability',
      actorType: 'tool', payload: { tool: 'synthetic_durable_action', idempotency_key: `${context.run.id}:synthetic` },
    }));
    const output = { durable: true, context_snapshot_id: context.snapshotId, eventSeq: event.seq };
    if (context.scenario === 'memory') await appendEvidenceMemory(context.env.DB, {
      workspaceId: context.run.workspace_id, siteId: context.run.site_id, agentId: id,
      kind: 'synthetic_verification', content: { durable_memory_verified: true },
      evidenceRefs: [`agent_event:${event.id}`], sourceRunId: context.run.id,
    });
    return { output, phase: 'completed' };
  },
});

const modules: RuntimeAgentModule[] = [
  { definition: agentDefinition('learning_agent'), loadContext: async () => [], createToolRegistry: env => learningTools(env), execute: runLearningAgent },
  {
    definition: agentDefinition('growth_leader'), loadContext: async () => [],
    execute: ({ env, step, run }) => runLeaderConversation({ env, step, runId: run.id }),
    settleCheckpoint: settleLeaderCheckpoint,
    wakeForEvent: async (env, target) => {
      const runId = target.targetRunId || publicationConversationId(target.siteId);
      if (!target.targetRunId) await createConversation(env, target, { id: runId, title: 'Pre-publish review', context: 'Pre-publish article review and automation for this site.' });
      await wakeConversation(env, target, runId);
    },
  },
  {
    definition: agentDefinition('business_research'), manualStartAllowed: false,
    createToolRegistry: env => businessResearchTools(env),
    loadContext: async () => [],
    execute: ({ env, step, run }) => runBusinessResearch({ env, step, runId: run.id }),
    onFailure: async (env, run, message) => { await stopTask(env.DB, run.id, 'failed', message, 'execution_failed'); },
  },
  syntheticModule('runtime_synthetic'),
  syntheticModule('runtime_synthetic_child'),
  {
    definition: agentDefinition('deep_research'), manualStartAllowed: false,
    onCancel: (env, run) => cancelFirecrawlResearch(env, run.id),
    validateStart: async (_env, input) => { researchBriefSchema.parse(input.summary); },
    createToolRegistry: () => new ToolRegistry(),
    loadContext: async () => [],
    execute: ({ env, step, run }) => runFirecrawlResearch({ env, step, runId: run.id }),
    onFailure: async (env, run, message) => { await stopTask(env.DB, run.id, 'failed', message, 'execution_failed'); },
  },
  {
    definition: agentDefinition('keyword_research'), parentAgentIds: ['strategy_research'], manualStartAllowed: false,
    validateStart: async (_env, input, site) => {
      const brief = keywordResearchTaskSchema.parse(input.summary);
      const configured = [String(site.source_locale || ''), ...JSON.parse(String(site.translate_locales_json || '[]')) as string[]];
      if (!configured.includes(brief.locale)) throw new Error('Keyword research language is not among the languages enabled for the project');
    },
    createToolRegistry: env => keywordResearchTools({ env, definition: agentDefinition('keyword_research') }),
    loadContext: async () => [],
    execute: runKeywordResearchConversation,
  },
  {
    definition: agentDefinition('strategy_research'),
    validateStart: async (_env, input, site) => {
      const summary = input.summary && typeof input.summary === 'object' ? input.summary as Record<string, unknown> : {};
      const locale = String(summary.locale || '').trim();
      const configured = [String(site.source_locale || ''), ...JSON.parse(String(site.translate_locales_json || '[]')) as string[]];
      if (!locale || !configured.includes(locale)) throw new Error('Strategy research language is not among the languages enabled for the project');
    },
    findBlockingBusinessRun: (env, input) => {
      const summary = input.summary && typeof input.summary === 'object' ? input.summary as Record<string, unknown> : {};
      return runningStrategyRun(env.DB, input.siteId, String(summary.locale || ''));
    },
    businessRunExists: async (env, runId) => Boolean(await getStrategyRun(env.DB, runId)),
    initializeBusinessRun: async (env, input, runId) => {
      const summary = input.summary && typeof input.summary === 'object' ? input.summary as Record<string, unknown> : {};
      return insertStrategyRun(
        env.DB, input.siteId, input.trigger, resolveModelProfile(env, 'strategy_research').model, String(summary.locale || ''), runId,
      ).then(() => undefined);
    },
    failBusinessStart: async (env, runId, message) => updateStrategyRun(env.DB, runId, {
      status: 'failed', phase: 'failed', error: message.slice(0, 2000), finished_at: new Date().toISOString(),
    }),
    createToolRegistry: (env) => strategyTaskTools({ env, definition: agentDefinition('strategy_research') }),
    loadContext: async (env, site, run) => {
      const strategyRun = await getStrategyRun(env.DB, run.id);
      if (!strategyRun?.source_locale) throw new Error('Strategy Run lost its locale identity');
      return loadStrategyResearchContext(env.DB, site as never, run.id, strategyRun.source_locale);
    },
    publicError: publicStrategyError,
    execute: async ({ env, step, run }) => {
      const result = await runStrategyConversation({ env, step, runId: run.id });
      const task = await taskForRun(env.DB, run.id);
      const terminal = task && ['completed', 'failed', 'cancelled'].includes(task.status);
      const status = task?.status === 'completed' ? 'ok' : task?.status === 'cancelled' ? 'cancelled'
        : task?.status === 'failed' ? 'failed' : task && ['paused', 'waiting'].includes(task.status) ? 'waiting' : 'running';
      await updateStrategyRun(env.DB, run.id, {
        status, phase: task?.status === 'completed' ? task.outcome : task?.status || result.phase,
        error: status === 'failed' ? task?.reason || '' : '', finished_at: terminal ? new Date().toISOString() : '',
      });
      return result;
    },
    onFailure: async (env, run, message) => {
      await stopTask(env.DB, run.id, 'failed', message, 'execution_failed');
      await env.DB.prepare(
        `update seo_strategy_runs set status = 'failed', phase = 'failed', error = ?, finished_at = ?
         where id = ? and status = 'running'`,
      ).bind(message.slice(0, 2000), new Date().toISOString(), run.id).run();
    },
  },
  {
    definition: agentDefinition('topic_decision'),
    validateStart: async (_env, input, site) => {
      const scope = topicScope(input.summary);
      if (!scope) throw new Error('Please select a topic language');
      scopedTopicSummary(input.summary as Record<string, unknown>);
      const configured = [String(site.source_locale || ''), ...JSON.parse(String(site.translate_locales_json || '[]')) as string[]];
      if (!configured.includes(scope.locale)) throw new Error('Topic language is not among the languages enabled for the project');
      if (input.instanceId !== topicInstance(scope)) throw new Error('Topic execution identity does not match its language');
    },
    createToolRegistry: createTopicDecisionToolRegistry,
    loadContext: (env, site, run) => loadTopicDecisionContext(env.DB, site as never, run),
    execute: runTopicConversation,
  },
  {
    definition: agentDefinition('content_production'),
    createToolRegistry: createContentProductionToolRegistry,
    loadContext: (env, site, run) => loadContentProductionContext(env.DB, site, run),
    execute: runContentParentConversation,
    onFailure: async (env, run, message) => {
      const summary = JSON.parse(run.summary_json || '{}') as Record<string, unknown>;
      if (summary.group_id) await markContentGroupAttention(env.DB, String(summary.group_id), message);
    },
  },
  {
    definition: agentDefinition('article_production'),
    parentAgentIds: ['content_production'], manualStartAllowed: false,
    createToolRegistry: env => createArticleProductionToolRegistry(env, true, 'all'),
    loadContext: (env, site, run) => loadArticleProductionContext(env.DB, site, run),
    execute: runArticleConversation,
  },
  {
    definition: agentDefinition('content_review'),
    parentAgentIds: ['content_production'], manualStartAllowed: false,
    afterCheckpoint: async env => { await dispatchPendingAgentEvents(env); },
    createToolRegistry: createContentReviewToolRegistry,
    loadContext: (env, site, run) => loadContentReviewContext(env.DB, site, run),
    execute: runReviewConversation,
    onFailure: async (env, run, message) => {
      const summary = JSON.parse(run.summary_json || '{}') as Record<string, unknown>;
      if (summary.group_id && summary.job_id && summary.artifact_id) await recordContentReviewInteraction(env.DB, {
        idempotencyKey: `content-review-failed:${run.id}`,
        groupId: String(summary.group_id), jobId: String(summary.job_id), artifactId: String(summary.artifact_id),
        parentRunId: run.parent_run_id || '', kind: 'parent_review_failed', actorType: 'workflow', actorId: 'content_review',
        summary: `This article's parent review Run failed: ${message}`, payload: { review_run_id: run.id, error: message },
      });
    },
  },
];

for (const module of modules) {
  if (!module.definition.hitlSinceVersion || !module.createToolRegistry) continue;
  const create = module.createToolRegistry;
  module.createToolRegistry = env => {
    const registry = create(env);
    if (!registry.names().includes('request_human_input')) registry.register(hitlTool(env));
    return registry;
  };
}

const moduleMap = new Map(modules.map((module) => [module.definition.id, module]));

export function runtimeAgentModule(agentId: AgentId): RuntimeAgentModule {
  const module = moduleMap.get(agentId);
  if (!module) throw new Error(`Agent module is not registered: ${agentId}`);
  return module;
}

export function registeredRuntimeAgentModules(): RuntimeAgentModule[] { return [...modules]; }

export function safeModuleError(module: RuntimeAgentModule, error: unknown): string {
  if (module.publicError) return module.publicError(error);
  return String(JSON.parse(runtimeJson({ message: error instanceof Error ? error.message : String(error) })).message || 'Agent Workflow failed').slice(0, 500);
}
