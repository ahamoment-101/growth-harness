import { LEADER_TOOL_NAMES } from '../growth-leader/prompt';
import { libraryToolNames } from '../keyword-library/catalog';
import { z } from 'zod';
import { researchDeliveryView } from './research-delivery-view';
import type { AgentPresence, RosterMember } from '../../shared/agent-roster';

export { AGENT_IDS, type AgentId } from '../../shared/agent-ids';
import { AGENT_IDS, type AgentId } from '../../shared/agent-ids';
export const CONVERSATION_TOOL_NAMES = ['cancel_current_run', 'approve_current_run', 'reject_current_run', 'provide_run_input'] as const;
export type ConversationToolName = (typeof CONVERSATION_TOOL_NAMES)[number];

const runtimeRunInputSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  workspaceId: z.string().trim().min(1).max(200),
  siteId: z.string().trim().min(1).max(200),
  agentId: z.enum(AGENT_IDS),
  instanceId: z.string().trim().max(200).optional(),
});

const syntheticOutputSchema = z.object({
  durable: z.literal(true), context_snapshot_id: z.string().min(1), eventSeq: z.number().int().positive(),
});

/** Domain submissions and terminal outcomes; Runtime audits have their own receipt. */
const strategyOutputSchema = z.object({
  outcome: z.enum(['completed', 'partial', 'unable_to_complete', 'no_change', 'waiting', 'paused', 'stopped']),
  task_id: z.string().optional(),
  strategy_version: z.number().int().nonnegative(), territories: z.number().int().nonnegative(),
  clusters: z.number().int().nonnegative(), keywords: z.number().int().nonnegative(),
  web_sources: z.number().int().nonnegative(), decision_turns: z.number().int().positive(),
  reason: z.string().optional(),
  next_focus: z.string().optional(),
}).refine(
  (value) => value.outcome !== 'completed' || value.strategy_version > 0,
  'A completed strategy Run must report the persisted strategy version',
);

const topicDecisionOutputSchema = z.object({
  result_id: z.string(),
  decision: z.enum(['topic_group', 'needs_research', 'defer']),
  status: z.enum(['draft', 'research_needed', 'deferred']),
  item_count: z.number().int().nonnegative().max(20),
  search_used: z.boolean(),
  decision_turns: z.number().int().positive(),
  rationale: z.string().optional(),
  defer: z.object({
    reason: z.string(), blockers: z.array(z.string()), recommended_action: z.string(), resume_when: z.string(),
  }).nullable().optional(),
});

const contentProductionOutputSchema = z.object({
  group_id: z.string().min(1),
  total_items: z.number().int().positive(),
  ready_items: z.number().int().nonnegative(),
  review_rounds: z.number().int().nonnegative(),
  action_turns: z.number().int().positive(),
  outcome: z.enum(['awaiting_human_review', 'completed', 'deferred']),
});

const articleProductionOutputSchema = z.object({
  outcome: z.enum(['submitted', 'deferred']),
  artifact_id: z.string(),
  job_id: z.string().min(1),
  attempt: z.number().int().positive(),
  locale_count: z.number().int().nonnegative(),
  action_turns: z.number().int().positive(),
  reason: z.string().optional(),
});

const contentReviewOutputSchema = z.object({
  outcome: z.enum(['reviewed', 'deferred']),
  artifact_id: z.string().min(1),
  job_id: z.string().min(1),
  decision: z.enum(['pass', 'revise']).nullable(),
  action_turns: z.number().int().positive(),
  reason: z.string().optional(),
});

export type AgentDefinition = {
  parameterContractVersion?: number;
  /** Pure domain views selected by the immutable task contract; old versions remain registered. */
  toolResultViews?: Record<number, Record<string, (output: unknown) => unknown>>;
  taskBased?: boolean;
  id: AgentId;
  label: string;
  /** Required: whether people meet this Agent as a team member or it stays a system internal. */
  presence: AgentPresence;
  promptLabel: string;
  mission: string;
  definitionVersion: number;
  /** First persisted definition whose model may compose a human input request. */
  hitlSinceVersion?: number;
  /** Opt-in for managing the Agent’s own existing information requests. */
  hitlResolutionSinceVersion?: number;
  promptVersion: string;
  contextSources: readonly string[];
  contextBudgetBytes: number;
  tools: readonly string[];
  injectedTool: 'read_synthetic_context' | 'read_strategy_research_context' | null;
  workflowBinding: 'AGENT_WORKFLOW';
  inputSchema: typeof runtimeRunInputSchema;
  outputSchema: z.ZodType;
  conversationTools: readonly ConversationToolName[];
  // Per-request capacity and business capabilities. Cumulative usage is observed,
  // never a termination policy; the persisted audit owns continuation decisions.
  runPolicy: {
    allowScheduled: boolean;
    allowApprovals: boolean;
    allowSubAgents: boolean;
    maxActiveChildren?: number;
  };
  memoryPolicy: 'none' | 'evidence_only';
};

const DEFINITIONS: Record<AgentId, AgentDefinition> = {
  learning_agent: {
    id: 'learning_agent', label: 'Business Learning', taskBased: true,
    presence: { kind: 'internal', reason: 'Maintains site-shared business experience and outcome feedback' },
    promptLabel: 'Business Learning Agent', mission: 'Learn business judgments from attributable practice and outcome evidence.',
    definitionVersion: 3, promptVersion: 'business-learning-v3-attributed-evidence', contextSources: [], contextBudgetBytes: 130_000,
    tools: ['read_learning_request','search_learning_history','list_learning_history','read_learning_experience','read_learning_history_page','calculate_learning_reward','submit_learning_result'],
    injectedTool: null, workflowBinding: 'AGENT_WORKFLOW', inputSchema: runtimeRunInputSchema, outputSchema: z.unknown(),
    conversationTools: [], runPolicy: { allowScheduled: true, allowApprovals: false, allowSubAgents: false }, memoryPolicy: 'none',
  },
  growth_leader: {
    id: 'growth_leader', label: 'AI Growth Leader', taskBased: true,
    presence: { kind: 'internal', reason: 'Site-specific conversation entry point, displayed in the classroom owner position' },
    promptLabel: 'AI Growth Leader', mission: 'Understand business and user goals, coordinate specialized Agents to advance growth work and judge delivered results.',
    definitionVersion: 22, hitlSinceVersion: 2, hitlResolutionSinceVersion: 22, promptVersion: 'growth-leader-v22-task-facts',
    contextSources: [], contextBudgetBytes: 150_000, tools: [...LEADER_TOOL_NAMES, 'provide_task_facts', 'read_todo', 'write_todo', 'read_my_inbox', 'complete_inbox_event', 'decide_publication', 'review_topic_group', 'request_human_input', 'read_human_input_requests', 'resolve_human_input_request'],
    injectedTool: null, workflowBinding: 'AGENT_WORKFLOW', inputSchema: runtimeRunInputSchema,
    outputSchema: z.unknown(), conversationTools: ['cancel_current_run'],
    runPolicy: { allowScheduled: true, allowApprovals: false, allowSubAgents: true }, memoryPolicy: 'none',
  },
  runtime_synthetic: {
    presence: { kind: 'internal', reason: 'Synthetic Agent for Runtime acceptance' },
    id: 'runtime_synthetic', label: 'Runtime synthetic acceptance agent',
    promptLabel: 'Runtime Synthetic Acceptance Agent',
    mission: 'Use synthetic data only to verify routing, tool permissions, Durable Workflow behavior, and realtime state.',
    definitionVersion: 5, promptVersion: 'runtime-synthetic-v2-english-prompts-english-v2',
    contextSources: ['synthetic_fixture'],
    contextBudgetBytes: 130_000,
    tools: ['read_synthetic_context', 'start_durable_workflow'],
    injectedTool: 'read_synthetic_context', workflowBinding: 'AGENT_WORKFLOW',
    inputSchema: runtimeRunInputSchema, outputSchema: syntheticOutputSchema,
    conversationTools: CONVERSATION_TOOL_NAMES,
    runPolicy: { allowScheduled: true, allowApprovals: true, allowSubAgents: true },
    memoryPolicy: 'evidence_only',
  },
  runtime_synthetic_child: {
    presence: { kind: 'internal', reason: 'Synthetic sub-Agent for Runtime acceptance' },
    id: 'runtime_synthetic_child', label: 'Runtime synthetic sub-agent',
    promptLabel: 'Runtime Synthetic Child Agent',
    mission: 'Act as an independent Durable Agent that verifies child-Agent identity, state, and trace behavior.',
    definitionVersion: 5, promptVersion: 'runtime-synthetic-child-v2-english-prompts-english-v2',
    contextSources: ['synthetic_fixture'], contextBudgetBytes: 130_000, tools: ['read_synthetic_context', 'start_durable_workflow'],
    injectedTool: 'read_synthetic_context', workflowBinding: 'AGENT_WORKFLOW',
    inputSchema: runtimeRunInputSchema, outputSchema: syntheticOutputSchema,
    conversationTools: ['cancel_current_run'],
    runPolicy: { allowScheduled: false, allowApprovals: false, allowSubAgents: false },
    memoryPolicy: 'evidence_only',
  },
  business_research: {
    presence: { kind: 'internal', reason: 'Business research capability will be merged into the AI Growth Leader; the AI Growth Leader\'s frontend and backend implementations are retained' },
    id: 'business_research', label: 'Business research agent', taskBased: true,
    promptLabel: 'Business Research Agent',
    mission: 'Research public website evidence and build the six business foundation Markdown documents.',
    definitionVersion: 8, hitlSinceVersion: 3, hitlResolutionSinceVersion: 8, promptVersion: 'business-research-v8-input-requests',
    contextSources: [], contextBudgetBytes: 150_000,
    tools: ['read_web_page', 'read_business_source', 'read_business_documents', 'save_business_document', 'finish_business_research', 'request_human_input', 'read_human_input_requests', 'resolve_human_input_request'],
    injectedTool: null, workflowBinding: 'AGENT_WORKFLOW',
    inputSchema: runtimeRunInputSchema, outputSchema: z.unknown(),
    conversationTools: ['cancel_current_run', 'provide_run_input'],
    // Bounds runaway execution; research depth and completion remain model decisions.
    runPolicy: { allowScheduled: false, allowApprovals: false, allowSubAgents: false },
    memoryPolicy: 'evidence_only',
  },
  strategy_research: {
    parameterContractVersion: 2,
    toolResultViews: { 2: { deep_research: researchDeliveryView } },
    presence: { kind: 'staff', name: 'Strategist', mission: 'Research the search landscape of each language market and produce and update the SEO strategy.' },
    id: 'strategy_research', label: 'Strategist', taskBased: true,
    promptLabel: 'Strategy Research Agent',
    mission: 'Understand each strategy request for this language market and carry out the strategy work that best serves it: research, delegated keyword research, a new strategy version, or an evidence-backed conclusion that none is needed.',
    definitionVersion: 45, hitlSinceVersion: 39, hitlResolutionSinceVersion: 45, promptVersion: 'strategy-library-v16-input-requests',
    contextSources: ['business_modules', 'site_state', 'search_performance', 'research_evidence', 'strategy_history', 'agent_memory'],
    contextBudgetBytes: 150_000,
    tools: ['list_keyword_library_languages', 'open_keyword_library', ...libraryToolNames(['read', 'research']), 'read_gsc_performance', 'fetch_competitor_sitemap', 'fetch_autocomplete', 'strategy_search_web', 'deep_research', 'research_keywords', 'read_strategy_workspace', 'read_business_module', 'read_site_content', 'read_strategy', 'read_evidence', 'read_web_page', 'create_strategy_blueprint', 'patch_strategy_blueprint', 'update_strategy_keywords', 'review_strategy', 'submit_strategy', 'restore_strategy_reports', 'request_human_input', 'read_human_input_requests', 'resolve_human_input_request', 'finish_strategy'],
    injectedTool: null, workflowBinding: 'AGENT_WORKFLOW',
    inputSchema: runtimeRunInputSchema, outputSchema: strategyOutputSchema,
    conversationTools: CONVERSATION_TOOL_NAMES,
    // Only per-request output capacity belongs in the business model configuration.
    runPolicy: { allowScheduled: false, allowApprovals: true, allowSubAgents: true },

    memoryPolicy: 'evidence_only',
  },
  deep_research: {
    presence: { kind: 'staff', name: 'Deep Researcher', mission: 'Conduct in-depth web research on a specific question and return traceable findings and evidence.' },
    id: 'deep_research', label: 'Firecrawl deep research Task', taskBased: true,
    promptLabel: 'Firecrawl Research Task', mission: 'Investigate a scoped question and deliver traceable findings, source evidence, and explicit uncertainty.',
    definitionVersion: 9, promptVersion: 'firecrawl-research-v1-english-v2',
    contextSources: [], contextBudgetBytes: 100_000,
    tools: [],
    injectedTool: null, workflowBinding: 'AGENT_WORKFLOW', inputSchema: runtimeRunInputSchema,
    outputSchema: z.object({ task_id: z.string(), outcome: z.enum(['completed','partial','needs_input','no_findings','paused','failed','cancelled']), summary: z.string(), report: z.string(), findings: z.array(z.unknown()), unknowns: z.array(z.string()), sources: z.array(z.unknown()), reason: z.string(), questions: z.array(z.unknown()).default([]), completion_assessment: z.record(z.string(), z.string()).optional() }),
    conversationTools: ['cancel_current_run'],
    runPolicy: { allowScheduled: false, allowApprovals: false, allowSubAgents: false },
    memoryPolicy: 'evidence_only',
  },
  keyword_research: {
    presence: { kind: 'staff', name: 'Keyword Researcher', mission: 'Research search expressions along the directions defined by the Strategist and maintain the keyword library for each language market.' },
    id: 'keyword_research', taskBased: true, label: 'Keyword research sub-agent',
    promptLabel: 'Keyword Research Sub-Agent',
    mission: 'Investigate the search expressions inside parent-chosen demand directions for one language market and maintain that market\'s independent keyword library from evidence, as its only AI writer, returning conclusions and actual change receipts to the parent. Market and competitor research belongs to the parent.',
    definitionVersion: 11, hitlSinceVersion: 4, hitlResolutionSinceVersion: 11, promptVersion: 'keyword-research-v11-input-requests',
    contextSources: [], contextBudgetBytes: 130_000,
    tools: ['list_keyword_library_languages', 'open_keyword_library', ...libraryToolNames(['read', 'research']), 'read_business_module', 'read_site_content', 'read_strategy', 'read_evidence', 'read_web_page', 'read_gsc_performance', 'fetch_competitor_sitemap', 'fetch_autocomplete', 'strategy_search_web', 'read_keyword_search_data', 'lookup_keyword_metrics', 'lookup_keyword_serp', 'finish_keyword_research', 'request_human_input', 'read_human_input_requests', 'resolve_human_input_request'],
    injectedTool: null, workflowBinding: 'AGENT_WORKFLOW',
    inputSchema: runtimeRunInputSchema, outputSchema: z.unknown(),
    conversationTools: ['cancel_current_run'],
    runPolicy: { allowScheduled: false, allowApprovals: false, allowSubAgents: false },
    memoryPolicy: 'evidence_only',
  },
  topic_decision: {
    presence: { kind: 'staff', name: 'Topic Editor', mission: 'Starting from the keyword library and published articles, pick out the next set of topics worth writing.' },
    id: 'topic_decision', taskBased: true, label: 'Topic decision agent',
    promptLabel: 'Topic Decision Agent',
    mission: 'Plan a portfolio of topics with SEO, GEO and thematic value from the specified language library, providing clear decision justifications for users and the writing team.',
    definitionVersion: 29, hitlSinceVersion: 23, hitlResolutionSinceVersion: 29, promptVersion: 'topic-decision-library-v20-input-requests',
    contextSources: ['active_strategies', 'run_constraints'],
    contextBudgetBytes: 130_000,
    tools: ['list_keyword_library_languages', 'read_topic_context', 'open_keyword_library', ...libraryToolNames(['read', 'topicLinks']), 'read_published_articles', 'topic_search_web', 'request_human_input', 'read_human_input_requests', 'resolve_human_input_request'],
    injectedTool: null, workflowBinding: 'AGENT_WORKFLOW',
    inputSchema: runtimeRunInputSchema, outputSchema: topicDecisionOutputSchema,
    conversationTools: ['cancel_current_run'],
    runPolicy: { allowScheduled: false, allowApprovals: false, allowSubAgents: false },
    memoryPolicy: 'evidence_only',
  },
  content_production: {
    presence: { kind: 'staff', name: 'Editor-in-Chief', mission: 'Split the confirmed topic set among Writers, arrange reviews, and collect qualified manuscripts.' },
    id: 'content_production', taskBased: true, label: 'Content creation agent',
    promptLabel: 'Content Production Agent',
    mission: 'Manage the article sub-Agents for one topic group as an editorial lead, delegate independent article reviews for reader value and SEO/GEO risk against the group strategy, return inadequate work with feedback, and send accepted work straight to human publication review.',
    definitionVersion: 28, hitlSinceVersion: 21, hitlResolutionSinceVersion: 28, promptVersion: 'content-production-agent-loop-v22-input-requests',
    contextSources: ['content_group'],
    contextBudgetBytes: 130_000,
    // Link tools remain declared for pinned v19 tasks; from v20 authors own internal links.
    tools: ['save_coverage_plan', 'inspect_content_group', 'read_content_article', 'read_published_articles', 'edit_article_internal_links', 'start_article_tasks', 'start_content_reviews', 'complete_content_group', 'defer_content_group', 'request_human_input', 'read_human_input_requests', 'resolve_human_input_request'],
    injectedTool: null, workflowBinding: 'AGENT_WORKFLOW',
    inputSchema: runtimeRunInputSchema, outputSchema: contentProductionOutputSchema,
    conversationTools: ['cancel_current_run'],
    runPolicy: { allowScheduled: false, allowApprovals: false, allowSubAgents: true, maxActiveChildren: 20 },
    memoryPolicy: 'evidence_only',
  },
  article_production: {
    presence: { kind: 'staff', name: 'Writer', mission: 'Responsible for the research and writing of one article, revising per review feedback until submission.' },
    id: 'article_production', taskBased: true, label: 'Article creation sub-agent',
    promptLabel: 'Article Production Sub-Agent',
    mission: 'Complete one topic task independently, use submission feedback to repair the source article and required localized versions, write from business facts and evidence, and explicitly defer when responsible completion is not possible.',
    definitionVersion: 26, hitlSinceVersion: 19, hitlResolutionSinceVersion: 26, promptVersion: 'article-production-agent-loop-v20-input-requests',
    // submit_article remains declared for pinned v16 tasks; v17 tasks find link targets, save, check and deliver.
    contextSources: ['article_task'], contextBudgetBytes: 80_000, tools: ['read_article_source', 'save_claim_evidence', 'read_published_articles', 'article_search_web', 'find_link_targets', 'submit_article', 'save_article_draft', 'run_self_check', 'deliver_article', 'defer_article', 'request_human_input', 'read_human_input_requests', 'resolve_human_input_request'], injectedTool: null, workflowBinding: 'AGENT_WORKFLOW',
    inputSchema: runtimeRunInputSchema, outputSchema: articleProductionOutputSchema,
    conversationTools: ['cancel_current_run'],
    runPolicy: { allowScheduled: false, allowApprovals: false, allowSubAgents: false },
    memoryPolicy: 'none',
  },
  content_review: {
    presence: { kind: 'staff', name: 'Reviewer', mission: 'Independently review each manuscript, decide whether it can be handed to a human reviewer, or send it back for revision.' },
    id: 'content_review', taskBased: true, label: 'Parent article review agent',
    promptLabel: 'Content Review Agent',
    mission: 'Perform one isolated parent-editor review of a locked candidate article, considering group strategy, reader value, and SEO/GEO risk, then pass it to human review, return it to the article sub-Agent, or defer when evidence is insufficient.',
    definitionVersion: 18, hitlSinceVersion: 12, hitlResolutionSinceVersion: 18, promptVersion: 'content-review-agent-loop-v12-input-requests',
    contextSources: ['content_review_task'], contextBudgetBytes: 210_000, tools: ['read_article_source', 'submit_content_review', 'defer_content_review', 'request_human_input', 'read_human_input_requests', 'resolve_human_input_request'], injectedTool: null, workflowBinding: 'AGENT_WORKFLOW',
    inputSchema: runtimeRunInputSchema, outputSchema: contentReviewOutputSchema,
    conversationTools: ['cancel_current_run'],
    runPolicy: { allowScheduled: false, allowApprovals: false, allowSubAgents: false },
    memoryPolicy: 'none',
  },
};

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_IDS.includes(value as AgentId);
}
export function agentDefinition(agentId: AgentId): AgentDefinition { return assertAgentDefinition(DEFINITIONS[agentId]); }
export function assertAgentDefinition(definition: AgentDefinition): AgentDefinition {
  if (definition.definitionVersion < 1 || !definition.promptVersion) throw new Error('Agent definition is invalid');
  if (definition.hitlSinceVersion !== undefined && (!Number.isInteger(definition.hitlSinceVersion) || definition.hitlSinceVersion < 1 || definition.hitlSinceVersion > definition.definitionVersion || !definition.tools.includes('request_human_input'))) throw new Error('Agent HITL version is invalid');
  if (!Number.isInteger(definition.contextBudgetBytes) || definition.contextBudgetBytes < 1) throw new Error('Agent context budget is invalid');
  const policy = definition.runPolicy;
  if (policy.maxActiveChildren !== undefined && (!Number.isInteger(policy.maxActiveChildren) || policy.maxActiveChildren < 1)) {
    throw new Error('Agent child concurrency is invalid');
  }
  if (definition.injectedTool && !definition.tools.includes(definition.injectedTool)) throw new Error('Injected context tool is not allowed by definition');
  const presence = definition.presence;
  if (presence.kind === 'internal' && !presence.reason.trim()) throw new Error('Internal Agent must state why it is hidden');
  if (presence.kind === 'staff' && (!presence.name.trim() || !presence.mission.trim())) throw new Error('Team member Agent needs a name and a mission');
  if (new Set(definition.tools).size !== definition.tools.length) throw new Error('Agent definition contains duplicate tools');
  for (const toolName of definition.conversationTools) {
    if (!CONVERSATION_TOOL_NAMES.includes(toolName)) throw new Error(`Agent definition references an unknown conversation tool: ${toolName}`);
  }
  if (!definition.runPolicy.allowApprovals && definition.conversationTools.some((name) => name === 'approve_current_run' || name === 'reject_current_run')) {
    throw new Error('Agent without approval capability cannot expose approval conversation tools');
  }
  return definition;
}
/** The team people meet: every staff Agent once, in registry order. */
export function agentRoster(): RosterMember[] {
  return AGENT_IDS.map(agentDefinition).flatMap((d) => d.presence.kind === 'staff' ? [{ agentId: d.id, name: d.presence.name, mission: d.presence.mission }] : []);
}
export function runtimeAgentName(workspaceId: string, siteId: string, agentId: AgentId, instanceId = ''): string {
  if (instanceId.includes('--')) throw new Error('Agent instance id cannot contain --');
  return `${encodeURIComponent(workspaceId)}--${encodeURIComponent(siteId)}--${agentId}${instanceId ? `--${encodeURIComponent(instanceId)}` : ''}`;
}
export function parseRuntimeAgentName(value: string): { workspaceId: string; siteId: string; agentId: AgentId; instanceId: string } | null {
  const parts = value.split('--');
  if ((parts.length !== 3 && parts.length !== 4) || !isAgentId(parts[2])) return null;
  try {
    const workspaceId = decodeURIComponent(parts[0]);
    const siteId = decodeURIComponent(parts[1]);
    const instanceId = parts[3] ? decodeURIComponent(parts[3]) : '';
    return workspaceId && siteId ? { workspaceId, siteId, agentId: parts[2], instanceId } : null;
  } catch { return null; }
}
