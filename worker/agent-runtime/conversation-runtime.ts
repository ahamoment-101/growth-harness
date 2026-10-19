import { readRuntimeJson } from './runtime-content';
import { conversationToolExecutor } from './conversation-tool-executor';
import { WORK_PROGRESS_INSTRUCTIONS, WORK_PROGRESS_MARKER } from './work-progress';
import { runAgentLoop, type AgentContext, type StreamFn } from '@earendil-works/pi-agent-core';
import { type Api, lazyStream, type AssistantMessage, type Message, type Model } from '@earendil-works/pi-ai';
import type { AgentDefinition } from './definitions';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { type ToolCompletion, type ToolRegistry } from './tools';
import { CONVERSATION_HISTORY_TOOL, conversationHistoryTool } from './conversation-context';
import { conversationTool } from './conversation-tools';
import { conversationChannel } from './conversation-channel';
import { replayConversationResponse } from './conversation-replay';
import { appendConversationMessage, conversationResumePoint, initializeConversation, readConversation, recordConversationRejection, closePendingConversationCalls } from './conversation-store';
import { requireTask, stopTask, taskDataJson, taskForRun,
  TaskPendingError, TaskStateError, type AgentTask, type TaskOperation } from './task-store';
import { maximumGenerationTokens, resolveModelProfile } from './model-registry';
import { executionFailure, ExecutionFailureError, type ExecutionFailure } from './execution-failure';
import { AUDIT_INSTRUCTIONS, AUDIT_TOOL, currentAudit, executionAuditTool, prepareAudit } from './execution-audit';
import { requestConversationModel, contextOverflowResponse, savedFailedResponse } from './conversation-request';
import { compactConversation } from './conversation-compaction';
import { ExecutionHandoff } from './runtime-executions';
import { TASK_MEMORY_TOOL, taskMemoryTool } from './task-memory';
import { readModelConversation } from './conversation-read';
import { HITL_AGENT_INSTRUCTIONS, hitlTool } from '../agent-work/hitl-tool';

export type ConversationAgent = {
  instructions: string;
  auditCompletionTools?: readonly string[];
  context: (task: AgentTask) => Promise<unknown>;
  tools: (task?: AgentTask, operation?: TaskOperation) => ToolRegistry;
  completionInstructions: string;
  initialWorkspace?: (context: unknown) => unknown;
  /** Optional domain pipeline stages append attributable changes, never rewrite history. */
  contextUpdates?: Array<(task: AgentTask) => Promise<{ key: string; content: unknown } | null>>;
  /** Translate verified provider tool-call encodings before SDK validation. The raw model receipt remains unchanged. */
  adaptModelResponse?: (response: AssistantMessage) => AssistantMessage;
};
type Input = {
  env: RuntimeAgentEnv; step: RuntimeWorkflowStep; runId: string; definition: AgentDefinition; agent: ConversationAgent;
  transport?: { model: Model<Api>; stream: StreamFn };
};
const native = (message: unknown): message is Message => Boolean(message && typeof message === 'object' &&
  ['user', 'assistant', 'toolResult'].includes(String((message as Message).role)));
/** A dropped stream, timeout, 429 or 5xx fails one physical request, not the host.
 * Consecutive failures wait in place; after the last delay the next failure replaces the Execution. */
const IN_PLACE_RETRY_DELAYS = ['5 seconds', '15 seconds', '45 seconds'] as const;
const terminal = (task: AgentTask): ToolCompletion => ({ status: task.status as ToolCompletion['status'], outcome: task.outcome, reason: task.reason, output: JSON.parse(task.output_json) });

/** Runtime owns the only advancement loop. Pi performs exactly one response and
 * its ordered tool batch, then returns across every pipeline boundary. */
export async function runConversationTask(input: Input): Promise<ToolCompletion> {
  const { env, runId, agent, step } = input;
  const definition = { ...input.definition, tools: [...input.definition.tools, CONVERSATION_HISTORY_TOOL, TASK_MEMORY_TOOL, AUDIT_TOOL] };
  let task = await taskForRun(env.DB, runId);
  if (!task || task.active_run_id !== runId) throw new TaskStateError('Conversation does not own this task');
  if (task.status !== 'running') return terminal(task);
  task = await requireTask(env.DB, runId);
  const scopedTools = (current = task!, operation?: TaskOperation) => {
    const registry = agent.tools(current, operation);
    if (definition.id !== 'strategy_research' && definition.hitlSinceVersion && current.definition_version >= definition.hitlSinceVersion) {
      registry.register(hitlTool(env, current, operation));
    }
    return registry.register(conversationHistoryTool(env)).register(taskMemoryTool(env)).register(executionAuditTool(env.DB, current, operation, agent.auditCompletionTools));
  };
  const inspection = scopedTools();
  const manifest = inspection.names().map(name => {
    const tool = inspection.resolve(definition, name);
    const pi = conversationTool(tool, async () => ({ content: [], details: {} }));
    return { name, version: tool.version, description: pi.description, parameters: pi.parameters };
  });
  let snapshot = await readConversation(env.DB, task, { initial: true });
  if (!snapshot) {
    const initial = await agent.context(task);
    const hitlInstructions = definition.hitlSinceVersion && task.definition_version >= definition.hitlSinceVersion && definition.id !== 'strategy_research'
      ? `\n${HITL_AGENT_INSTRUCTIONS}` : '';
    await initializeConversation(env.DB, task, agent.instructions + hitlInstructions + '\n' + agent.completionInstructions + '\n' + AUDIT_INSTRUCTIONS + '\n' + WORK_PROGRESS_INSTRUCTIONS, initial, agent.initialWorkspace?.(initial), manifest);
    snapshot = (await readConversation(env.DB, task, { initial: true }))!;
  }
  const pinned = await env.DB.prepare('select tool_manifest_json from agent_conversations where task_id=?').bind(task.id).first<{ tool_manifest_json: string }>();
  if (pinned && pinned.tool_manifest_json !== '[]' && pinned.tool_manifest_json !== taskDataJson(manifest)) throw new TaskStateError('Pinned tool contract differs from this executor; restore its registered version');
  if (!snapshot.messages.length && !snapshot.compaction) {
    await appendConversationMessage(env.DB, task, 'trigger', { role: 'user', timestamp: Date.parse(task.created_at),
      content: `Internal task trigger and trusted initial context:\n${taskDataJson(snapshot.context)}` });
  }
  const assignment = await env.DB.prepare('select context_json from agent_task_assignments where id=? and task_id=?').bind(task.assignment_id, task.id).first<{context_json:string}>();
  if (assignment) await appendConversationMessage(env.DB, task, `assignment:${task.assignment_id}`, { role: 'user', timestamp: Date.parse(task.created_at), content: `Business delegation:\n${JSON.stringify(await readRuntimeJson(env.DB, assignment.context_json))}` });
  const profile = input.transport ? null : resolveModelProfile(env, definition.id);
  const maxTokens = profile ? maximumGenerationTokens(profile) : input.transport!.model.maxTokens;
  const transport = input.transport || conversationChannel(profile!);
  let fatal: unknown;
  let auditMode = false;
  let transientFailures = 0;

  const execute = conversationToolExecutor({ env, step, runId, definition, scopedTools });

  try {
    for (;;) {
      task = await taskForRun(env.DB, runId);
      if (!task || task.active_run_id !== runId) throw new TaskStateError('Conversation authority changed');
      if (task.status !== 'running') return terminal(task);
      task = await requireTask(env.DB, runId);
      snapshot = (await readModelConversation(env.DB, task, transport.model, manifest))!;
      let point = conversationResumePoint(snapshot);
      // Saved incomplete operations take precedence over new input and audit messages.
      if (!point.pending) {
        const inputs = await env.DB.prepare(`select i.* from agent_task_inputs i where i.task_id=?
          and not exists(select 1 from agent_conversation_messages m where m.task_id=i.task_id and m.message_key='input:'||i.id)
          order by i.created_at,i.id`).bind(task.id).all<{ id: string; actor_id: string; content: string; created_at: string }>();
        for (const value of inputs.results) await appendConversationMessage(env.DB, task, `input:${value.id}`, {
          role: 'user', timestamp: Date.parse(value.created_at), content: `Task assignment from ${value.actor_id}:\n${value.content}`,
        });
        for (const update of agent.contextUpdates || []) {
          const value = await update(task);
          if (value) await appendConversationMessage(env.DB, task, `context:${value.key}`, { role: 'user', timestamp: Date.now(), content: taskDataJson(value.content) });
        }
      }
      const audit = await prepareAudit(env.DB, task);
      auditMode = point.pending
        ? (await env.DB.prepare('select decision_kind from agent_conversation_messages where task_id=? and message_key=?').bind(task.id, point.pendingKey).first<{ decision_kind: string }>())?.decision_kind === 'audit'
        : audit.status === 'auditing';
      if (auditMode && !point.pending) {
        const key = `audit:${audit.number}`;
        const existing = await env.DB.prepare('select 1 from agent_conversation_messages where task_id=? and message_key=?').bind(task.id, key).first();
        if (!existing) await appendConversationMessage(env.DB, task, key, { role: 'user', timestamp: Date.now(),
          content: `Execution audit ${audit.number}: ${audit.end_decision} normal decisions have completed. Review saved progress, remaining work, failures and uncertainties. Read necessary information and call ${AUDIT_TOOL}. Continue autonomously with a concrete next method, or finish with an honest outcome. New business mutations are suspended for this audit.` });
      }
      snapshot = (await readModelConversation(env.DB, task, transport.model, manifest))!;
      point = conversationResumePoint(snapshot);
      // Some providers reject a request whose final history message is an
      // assistant turn. A resumed/deferred conversation can legitimately end
      // there, so append a durable continuation input without replacing history.
      if (!point.pending && point.messages.at(-1)?.role === 'assistant') {
        const lastSequence = snapshot.messages.at(-1)?.sequence || snapshot.compaction?.throughSequence || 0;
        await appendConversationMessage(env.DB, task, `continuation:${lastSequence}`, {
          role: 'user', timestamp: Date.now(),
          content: 'This task is active again. Reassess the saved progress and current state, then choose the next permitted action or a concrete wait condition.',
        });
        snapshot = (await readModelConversation(env.DB, task, transport.model, manifest))!;
        point = conversationResumePoint(snapshot);
      }
      const responseKey = point.pendingKey || `response:${(snapshot.messages.at(-1)?.sequence || snapshot.compaction?.throughSequence || 0) + 1}`;
      const context: AgentContext = { systemPrompt: snapshot.instructions, messages: point.messages,
        tools: inspection.names().map(name => conversationTool(inspection.resolve(definition, name), async (id, args) => {
          try { return await execute(name, id, args); }
          catch (error) {
            if (error instanceof TaskStateError || error instanceof TaskPendingError || error instanceof ExecutionFailureError || error instanceof ExecutionHandoff) fatal = error;
            throw error;
          }
        })) };
      // A saved response needs tool reconciliation, not another model request.
      // Resolve it first; only the next new decision requires capacity maintenance.
      const compacted = point.pending ? snapshot : await compactConversation({ env, step, task, snapshot,
        context: { systemPrompt: context.systemPrompt, messages: context.messages.filter(native), tools: context.tools },
        model: transport.model, stream: transport.stream, outputTokens: maxTokens });
      if (compacted.compaction?.version !== snapshot.compaction?.version) continue;
      const durableStream: StreamFn = (model, modelContext, options) => lazyStream(model, async () => {
        try {
          const response = await requestConversationModel({ env, step, runId, decisionId: responseKey,
            purpose: auditMode ? 'execution_audit' : 'conversation', turn: snapshot!.normalDecisions + 1,
            context: modelContext, model: transport.model, stream: transport.stream, maxTokens, options });
          return await replayConversationResponse(response, transport.stream, agent.adaptModelResponse)(model, modelContext, options);
        } catch (error) {
          // A retryable provider status is saved as an incomplete response, like a dropped stream.
          if (error instanceof ExecutionFailureError && error.failure.recovery_action === 'retry_request' && error.failure.scope === 'request') {
            const failed = await savedFailedResponse(env, runId, responseKey);
            if (failed) return replayConversationResponse(failed, transport.stream, agent.adaptModelResponse)(model, modelContext, options);
          }
          fatal = error; throw error;
        }
      });
      let incompleteResponse = false;
      let observedResponse: AssistantMessage | undefined;
      const stream = point.pending ? replayConversationResponse(point.pending, durableStream, agent.adaptModelResponse) : durableStream;
      // Empty prompts preserve the existing conversation, including an assistant
      // text response. The SDK's Continue entry point rejects that role and would
      // require a synthetic user message merely to satisfy its local guard.
      await runAgentLoop([], context, {
        model: transport.model, maxTokens, convertToLlm: messages => messages.filter(native), toolExecution: 'sequential',
        shouldStopAfterTurn: () => true,
        beforeToolCall: async ({ toolCall }) => {
          const current = await taskForRun(env.DB, runId);
          if (fatal || current?.status !== 'running') return { block: true, reason: 'Task execution stopped; this call was not executed', terminate: true };
          await requireTask(env.DB, runId);
          if (incompleteResponse) return { block: true, reason: 'Model response was incomplete; this tool call was not executed. Submit complete arguments in a new decision.' };
          const tool = inspection.resolve(definition, toolCall.name);
          if (toolCall.name === AUDIT_TOOL && !auditMode) return { block: true, reason: 'No active audit; use the normal business tools' };
          if (auditMode && tool.capability !== 'read') return { block: true, reason: 'Business mutations are suspended until the audit is resolved' };
          // continue does not enable later writes from the same audit response.
          if (toolCall.name === AUDIT_TOOL && (await currentAudit(env.DB, current.id)).status !== 'auditing') return { block: true, reason: 'This audit already has a durable decision' };
          return undefined;
        },
      }, async event => {
        if (event.type !== 'message_end' || !native(event.message)) return;
        const current = (await taskForRun(env.DB, runId))!;
        if (event.message.role === 'assistant') {
          observedResponse = event.message;
          incompleteResponse = ['error','aborted','length'].includes(event.message.stopReason);
          if (fatal) throw fatal;
          await appendConversationMessage(env.DB, current, responseKey, event.message, auditMode ? 'audit' : 'normal', snapshot!.instructions.includes(WORK_PROGRESS_MARKER));
        } else if (event.message.role === 'toolResult' && current.status !== 'cancelled') {
          // A host handoff or unresolved request is not a completed tool result.
          // Keep the saved call pending so the next Execution resumes its operation.
          if (fatal) throw fatal;
          await recordConversationRejection(env.DB, current, event.message.toolCallId, event.message);
          await appendConversationMessage(env.DB, current, `tool:${event.message.toolCallId}`, event.message);
        }
      }, undefined, stream);
      if (incompleteResponse) {
        await closePendingConversationCalls(env.DB, runId, 'Incomplete model response; tool call not executed');
        const current = (await taskForRun(env.DB, runId))!;
        await appendConversationMessage(env.DB, current, `model-feedback:${responseKey}`, { role: 'user', timestamp: Date.now(), content: 'The previous model response was incomplete. Its tool calls were not executed. Use the saved tool results and submit complete arguments if the action is still needed.' });
      }
      if (fatal) throw fatal;
      const latest = (await taskForRun(env.DB, runId))!;
      if (latest.status !== 'running') return terminal(latest);
      const last = observedResponse;
      if (last?.role === 'assistant' && ['error','aborted'].includes(last.stopReason) && !contextOverflowResponse(last)) {
        if (transientFailures < IN_PLACE_RETRY_DELAYS.length) {
          await step.sleep(`model-retry-${responseKey}`, IN_PLACE_RETRY_DELAYS[transientFailures++]);
          continue;
        }
        const saved = (last as AssistantMessage & { executionFailure?: ExecutionFailure }).executionFailure;
        throw new ExecutionFailureError(saved || { origin: 'upstream', scope: 'request', recovery_action: 'retry_request', message: last.errorMessage || 'Model temporarily unavailable', status: 0, request_id: last.responseId || '', stage: 'conversation' });
      }
      if (last?.role === 'assistant') transientFailures = 0;
    }
  } catch (error) {
    if (error instanceof ExecutionHandoff || error instanceof ExecutionFailureError) throw error;
    const current = await taskForRun(env.DB, runId);
    if (!current || current.status === 'cancelled') throw error;
    if (current.status !== 'running') return terminal(current);
    await requireTask(env.DB, runId);
    const platform = executionFailure(error, 'conversation');
    if (platform) throw new ExecutionFailureError(platform);
    await stopTask(env.DB, runId, 'paused', String(error), error instanceof TaskPendingError ? 'external_pending' : 'execution_failed');
    return terminal((await taskForRun(env.DB, runId))!);
  }
}
