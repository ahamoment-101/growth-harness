import { decodeExecution, encodeExecutionBoundary, ExecutionFailureError, type ExecutionFailure } from './execution-failure';
import { requestObservation } from './request-observation';
import { readRuntimeJson } from './runtime-content';
import type { Api, Context, AssistantMessage, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { commitTaskModel, prepareTaskModel, requireTask, taskDataJson, TaskPendingError } from './task-store';
import { MODEL_ATTEMPT_STEP } from './runtime-limits';
import { traceRuntimeModelAttempt } from './observability';
import { calibratedRequestCapacity, measuredAssistant } from './request-calibration';

export function contextOverflowResponse(message: AssistantMessage): boolean {
  return (message as AssistantMessage & { runtimeFailure?: string }).runtimeFailure === 'context_overflow';
}

function executionFailureResponse(message: AssistantMessage): boolean {
  return (message as AssistantMessage & { runtimeFailure?: string }).runtimeFailure === 'execution_failure';
}

/** The saved receipt of a request that ended in a classified provider failure.
 * The conversation host records it as an incomplete response before a new decision retries. */
export async function savedFailedResponse(env: RuntimeAgentEnv, runId: string, decisionId: string): Promise<AssistantMessage | null> {
  const task = await requireTask(env.DB, runId);
  const saved = await env.DB.prepare(`select response_json from agent_task_model_reservations
    where task_id=? and operation_id=? and status='succeeded' order by created_at desc,id desc limit 1`)
    .bind(task.id, `${task.id}:${decisionId}`).first<{ response_json: string }>();
  if (!saved) return null;
  const response = await readRuntimeJson<AssistantMessage>(env.DB, saved.response_json);
  return executionFailureResponse(response) ? response : null;
}

/** A single logical request. Durable steps return a receipt ID, never a transcript. */
export async function requestConversationModel(input: {
  env: RuntimeAgentEnv; step: RuntimeWorkflowStep; runId: string; decisionId: string;
  purpose: string; turn: number; context: Context; model: Model<Api>;
  stream: StreamFn; maxTokens: number; options?: SimpleStreamOptions;
  requireCompleteResponse?: boolean;
  /** Context maintenance consumes a saved truncation as a split checkpoint. */
  reuseTruncatedResponse?: boolean;
}): Promise<AssistantMessage> {
  const { env, runId, decisionId, purpose } = input;
  const task = await requireTask(env.DB, runId);
  const operationId = `${task.id}:${decisionId}`;
  const prior = await env.DB.prepare(`select id,status,response_json from agent_task_model_reservations
    where task_id=? and operation_id=? order by created_at desc,id desc limit 1`)
    .bind(task.id, operationId).first<{ id: string; status: string; response_json: string }>();
  let replaceFailedPredecessor = false;
  if (prior?.status === 'succeeded') {
    const response = await readRuntimeJson<AssistantMessage>(env.DB, prior.response_json);
    replaceFailedPredecessor = executionFailureResponse(response);
    if (!replaceFailedPredecessor && (!input.requireCompleteResponse || (input.reuseTruncatedResponse && response.stopReason === 'length') || !['error','aborted','length'].includes(response.stopReason))) return response;
  }
  if (prior?.status === 'running') throw new TaskPendingError(`Unsettled model request ${prior.id}; reconcile the original request before another physical attempt`);
  // A saved response is reusable without making another request. Capacity only
  // gates a new physical call, not recovery of an existing decision.
  const capacity = await calibratedRequestCapacity(input.context, input.model);
  if (!capacity.known || capacity.allowedOutputTokens <= 0) throw new ExecutionFailureError({
    origin: 'local_platform', scope: 'request', recovery_action: 'pause', status: 0,
    request_id: '', stage: purpose, message: 'Model request capacity is unavailable; context maintenance is required',
  });
  const maxTokens = capacity.allowedOutputTokens;
  const requestId = `${env.execution?.executionId || task.execution_id || runId}:${decisionId}`;
  const request = { systemPrompt: input.context.systemPrompt, messages: input.context.messages,
    tools: input.context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) };
  const savedId = decodeExecution(await input.step.do(`request-${decisionId}`, MODEL_ATTEMPT_STEP, async () => encodeExecutionBoundary(async () => {
    const prepared = await prepareTaskModel(env.DB, { runId, reservationId: requestId, operationId: decisionId,
      tokens: new TextEncoder().encode(taskDataJson(request)).length + maxTokens,
      request, reusePredecessor: true, excludeFailedAssistant: input.requireCompleteResponse || replaceFailedPredecessor });
    if (prepared.response !== null) return prepared.receiptId;
    const observation = requestObservation(env.DB, task.id, requestId);
    await traceRuntimeModelAttempt(env.DB, { runId, purpose, physicalId: requestId, decisionTurn: input.turn,
      attempt: env.execution?.epoch || 1, provider: input.model.provider, model: input.model.id, verifiedRun: true,
      usage: (value: AssistantMessage) => ({ inputTokens: value.usage.input + value.usage.cacheRead + value.usage.cacheWrite, outputTokens: value.usage.output, requestId: value.responseId }),
    }, async () => {
      let message = await (await input.stream(input.model, input.context, { ...input.options, onPayload: observation.onPayload, fetch: observation.fetch, maxTokens })).result();
      await observation.commit();
      if (message.stopReason === 'error' && observation.errorCode === 'context_length_exceeded') {
        message = { ...message, runtimeFailure: 'context_overflow' } as AssistantMessage;
      }
      let requestFailure: ExecutionFailure | null = null;
      if (message.stopReason === 'error' && observation.httpStatus >= 400 && !contextOverflowResponse(message)) {
        const transient = observation.httpStatus === 429 || observation.httpStatus >= 500;
        // Credential, billing and permission refusals depend on the provider account,
        // not on this request, so an unchanged request succeeds once the account does.
        // They wait in a replacement execution; other 4xx stay paused because retrying cannot help.
        const account = observation.httpStatus >= 401 && observation.httpStatus <= 403;
        requestFailure = { origin: 'upstream', scope: account ? 'account' : 'request', recovery_action: transient ? 'retry_request' : account ? 'new_execution' : 'pause', status: observation.httpStatus, request_id: message.responseId || '', stage: purpose,
          message: message.errorMessage || (transient ? 'Provider temporarily unavailable' : account ? 'Provider account refused the request' : 'Provider rejected the request protocol or configuration') };
        message = { ...message, runtimeFailure: 'execution_failure', executionFailure: requestFailure } as AssistantMessage;
      }
      await commitTaskModel(env.DB, runId, requestId, await measuredAssistant(message, input.context, input.model), message.usage.totalTokens || undefined);
      if (requestFailure) throw new ExecutionFailureError(requestFailure);
      return message;
    });
    return requestId;
  }, `model_request:${purpose}`)));
  const saved = await env.DB.prepare("select response_json from agent_task_model_reservations where id=? and task_id=? and status='succeeded'")
    .bind(savedId, task.id).first<{ response_json: string }>();
  if (!saved) throw new TaskPendingError('Model response receipt is not settled');
  return readRuntimeJson<AssistantMessage>(env.DB, saved.response_json);
}
