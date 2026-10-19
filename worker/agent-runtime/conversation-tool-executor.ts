import { persistRuntimeJson, readRuntimeJson } from './runtime-content';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentDefinition } from './definitions';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { replaysAfterInterruption, type ToolRegistry } from './tools';
import { bindConversationOperation } from './conversation-store';
import { finishTaskOperation, finishTaskTerminal, requireTask, taskDataJson, taskForRun, TaskPendingError, TaskStateError, type AgentTask, type TaskOperation } from './task-store';
import { toolCallStep } from './runtime-limits';
import { classifyToolFailure } from './tool-failure';
import { decodeTaskStep, encodeToolStep, restoreToolStepFailure } from './task-step-result';
import { executionFailure, ExecutionFailureError } from './execution-failure';
import { runtimeErrorAction } from './runtime-error-policy';
import { ExecutionHandoff } from './runtime-executions';
const outputResult = (output: unknown): AgentToolResult<unknown> => ({ content: [{ type: 'text', text: taskDataJson(output) }], details: output });

/** One durable tool executor, shared by the task host and native Pi hosts. */
export function conversationToolExecutor(input: {
  env: RuntimeAgentEnv; step: RuntimeWorkflowStep; runId: string; definition: AgentDefinition;
  scopedTools: (task: AgentTask, operation?: TaskOperation) => ToolRegistry;
}) {
  const { env, step, runId, definition, scopedTools } = input;
  async function execute(name: string, callId: string, args: unknown): Promise<AgentToolResult<unknown>> {
    const current = await requireTask(env.DB, runId);
    const operation = await bindConversationOperation(env.DB, current, callId, {});
    const tool = scopedTools(current, operation).resolve(definition, name);
    if (operation.status === 'succeeded') {
      await finishTaskOperation(env.DB, current, operation, JSON.parse(operation.output_json));
      return outputResult(JSON.parse(operation.output_json));
    }
    if (operation.status === 'failed') throw new Error(operation.output_json !== '{}' ? operation.output_json : operation.error);
    if (operation.status === 'unknown' || (operation.status === 'running' && !replaysAfterInterruption(tool))) {
      throw new TaskPendingError('Previous tool effects require reconciliation');
    }
    const gate = await env.DB.prepare(`update agent_task_operations set status='running',external_json=? where id=? and status in ('ready','running')
      and exists(select 1 from agent_tasks where id=? and active_run_id=? and epoch=? and status='running')`)
      .bind(taskDataJson({ replay_safety: tool.capability === 'read' ? 'repeatable' : tool.replaySafety === 'unreconciled' ? 'unknown' : tool.replaySafety }), operation.id, current.id, runId, current.epoch).run();
    if (!gate.meta.changes) throw new TaskStateError('Tool execution lost its task gate');
    try {
      if (tool.approval === 'required') throw new TaskStateError('Tool requires explicit business approval');
      if (!tool.execute) throw new TaskStateError('Conversation tool has no executor');
      const invoke = async () => {
        await requireTask(env.DB, runId);
        const signal = tool.executionMode === 'durable_async' || tool.executionMode === 'durable_call' ? undefined : AbortSignal.timeout(tool.timeoutMs);
        return tool.outputSchema.parse(await tool.execute!(tool.inputSchema.parse(args), {
          runId, workspaceId: current.workspace_id, siteId: current.site_id, idempotencyKey: operation.id, signal, execution: env.execution,
        }));
      };
      const output = tool.executionMode === 'durable_async' || tool.executionMode === 'durable_call'
        ? await invoke()
        : decodeTaskStep(await readRuntimeJson(env.DB, await step.do(`conversation-tool-${operation.turn}`, toolCallStep(tool.timeoutMs, tool.retryable && replaysAfterInterruption(tool)), async () => persistRuntimeJson(env.DB, await encodeToolStep(invoke, {
          retryable: tool.retryable && replaysAfterInterruption(tool),
          readOnly: tool.capability === 'read' || tool.replaySafety === 'repeatable',
        })))));
      const completion = tool.completion?.(output);
      const state = await taskForRun(env.DB, runId);
      if (completion && state?.status === 'running') await finishTaskTerminal(env.DB, current, operation, completion);
      else if (!completion && state?.status === 'running') await finishTaskOperation(env.DB, current, operation, output);
      return outputResult(output);
    } catch (error) {
      error = restoreToolStepFailure(error);
      if (error instanceof ExecutionHandoff) throw error;
      const state = await taskForRun(env.DB, runId);
      if (state?.status === 'completed') return outputResult(JSON.parse(state.output_json));
      await requireTask(env.DB, runId);
      const receipt = await env.DB.prepare('select * from agent_task_operations where id=? and task_id=?').bind(operation.id, current.id).first<TaskOperation>();
      if (receipt?.status === 'succeeded') {
        const output = await readRuntimeJson(env.DB, receipt.output_json);
        await finishTaskOperation(env.DB, current, receipt, output);
        return outputResult(output);
      }
      if (error instanceof TaskStateError || error instanceof TaskPendingError) throw error;
      const platform = executionFailure(error, 'tool');
      if (platform && platform.recovery_action !== 'retry_request') throw new ExecutionFailureError(platform);
      const failure = classifyToolFailure(error);
      failure.effects ??= tool.capability === 'read' || tool.replaySafety === 'repeatable' ? 'none' : 'unknown';
      const output = { error: error instanceof Error ? error.message : String(error), ...failure };
      if (failure.effects === 'unknown' && !replaysAfterInterruption(tool)) {
        await env.DB.prepare(`update agent_task_operations set status='unknown',error=?,output_json=? where id=? and status='running'
          and exists(select 1 from agent_tasks where id=? and active_run_id=? and epoch=? and status='running')`)
          .bind(String(error).slice(0, 2000), taskDataJson(output), operation.id, current.id, runId, current.epoch).run();
        throw new TaskPendingError('Tool effect outcome is unknown; reconcile the original operation');
      }
      await finishTaskOperation(env.DB, current, operation, output, String(error));
      const policy = runtimeErrorAction(failure);
      if (policy.action === 'recover') throw new ExecutionFailureError(policy.failure);
      throw new Error(taskDataJson(output));
    }
  }

  return execute;
}
