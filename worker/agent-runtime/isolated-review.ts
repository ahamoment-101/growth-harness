import { z } from 'zod';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { ToolExecutionError } from './tool-failure';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import type { AgentDefinition } from './definitions';
import { maximumGenerationTokens, resolveModelProfile } from './model-registry';
import { conversationChannel } from './conversation-channel';
import { requestConversationModel, contextOverflowResponse } from './conversation-request';
import { taskDataJson } from './task-store';
import { compactIsolatedContext } from './conversation-compaction';

/** An isolated reviewer returns evidence to its caller. It has no hidden loop,
 * tool effects or independent business goal, and uses the same durable requests. */
export async function isolatedReview<T>(input: { env: RuntimeAgentEnv; step: RuntimeWorkflowStep; runId: string;
  operationId: string; definition: AgentDefinition; instructions: string; material: unknown; schema: z.ZodType<T> }): Promise<T> {
  const profile = resolveModelProfile(input.env, input.definition.id);
  const maxTokens = maximumGenerationTokens(profile);
  const transport = conversationChannel(profile);
  let context = await compactIsolatedContext({ env: input.env, step: input.step, runId: input.runId,
    requestKey: `review:${input.operationId}`, model: transport.model, stream: transport.stream, outputTokens: maxTokens,
    context: { systemPrompt: input.instructions + '\nReturn only a JSON object matching this schema:\n' + taskDataJson(z.toJSONSchema(input.schema)),
      messages: [{ role: 'user', timestamp: 0, content: taskDataJson(input.material) }] } });
  for (let maintenance = 0; ; maintenance++) {
    const decisionId = maintenance ? `review:${input.operationId}:capacity:${maintenance}` : `review:${input.operationId}`;
    const response = await requestConversationModel({ env: input.env, step: input.step, runId: input.runId, decisionId,
      purpose: 'isolated_review', turn: Number(input.operationId.split(':').at(-1)) || 1, context, model: transport.model, stream: transport.stream, maxTokens });
    if (!contextOverflowResponse(response)) return parseIsolatedReview(response, input.schema, decisionId);
    context = await compactIsolatedContext({ env: input.env, step: input.step, runId: input.runId,
      requestKey: `${decisionId}:rejected-capacity`, context, model: transport.model, stream: transport.stream,
      outputTokens: maxTokens, rejectedCapacity: true });
  }
}

/** Preserve unvalidated reviewer output as evidence for the parent decision. */
export function parseIsolatedReview<T>(response: AssistantMessage, schema: z.ZodType<T>, requestId: string): T {
  const text = response.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const observation = { requestId, stopReason: response.stopReason, text };
  const fail = (message: string, issues: Array<{ path: Array<string | number>; message: string }> = []): never => {
    throw new ToolExecutionError(message, { kind: 'invalid_output', retryable: false, effects: 'none', issues, observation,
      guidance: 'The isolated reviewer produced no validated review. Its preserved text may be incomplete or invalid; it is not an approved finding. The parent can use this evidence to choose its next action.' });
  };
  if (['error', 'aborted', 'length'].includes(response.stopReason)) return fail(`Review response incomplete: ${response.errorMessage || response.stopReason}`);
  let value: unknown;
  try { value = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { return fail('Review response is not valid JSON', [{ path: [], message: 'Expected a JSON object matching the review schema' }]); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return fail('Review response violates its output contract', parsed.error.issues.map(issue => ({
    path: issue.path.map(part => typeof part === 'number' ? part : String(part)), message: issue.message,
  })));
  return parsed.data;
}
