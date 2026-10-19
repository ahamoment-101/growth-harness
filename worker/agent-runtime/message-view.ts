import type { Context, Message } from '@earendil-works/pi-ai';

export function compactionMessage(throughSequence: number, summary: string): Message {
  return { role: 'user', timestamp: 0,
    content: `Persistent context summary through sequence ${throughSequence} (archive remains authoritative):\n${summary}` };
}

/** Native model history keeps provider metadata needed for replay, but not the
 * SDK's host-only tool details. Domain output lives in the operation receipt. */
export function conversationMessage(message: Message): Message {
  if (message.role !== 'toolResult') return message;
  const { details: _details, ...native } = message as typeof message & { details?: unknown };
  return native;
}

export function failedModelMessage(message: Message): boolean {
  return message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason);
}

/** Failed provider output is an observation, never an assistant tool directive. */
export function modelHistoryMessage(message: Message, failedCalls: ReadonlySet<string>): Message {
  if (message.role === 'assistant' && failedModelMessage(message)) {
    return { role: 'user', timestamp: message.timestamp,
      content: `Model request failed (${message.stopReason}). Partial output is archived and is not an executable decision. Error: ${message.errorMessage || 'Provider interrupted the response'}` };
  }
  if (message.role === 'toolResult' && failedCalls.has(message.toolCallId)) {
    return { role: 'user', timestamp: message.timestamp,
      content: `Result for rejected incomplete call ${message.toolCallId} (${message.toolName}): ${JSON.stringify(message.content)}` };
  }
  return conversationMessage(message);
}

/** Semantic view only. Durable operation receipts remain authoritative for effects.
 * Neither duplicated tool details nor private reasoning belong in a summary. */
export function semanticMessage(message: Message) {
  const visible = modelHistoryMessage(message, new Set());
  return {
    role: visible.role,
    content: typeof visible.content === 'string' ? visible.content : visible.content.filter(block => block.type !== 'thinking'),
    ...(message.role === 'assistant' && message.stopReason === 'length'
      ? { response_status: 'incomplete', stop_reason: 'length' } : {}),
    ...(message.role === 'toolResult' ? {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    } : {}),
  };
}

export function semanticRequest(context: Context) {
  return {
    systemPrompt: context.systemPrompt,
    tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
    messages: context.messages.map(semanticMessage),
  };
}

/** Request sizing includes native replay blocks even though summaries exclude
 * them. The adapter may serialize these as reasoning_content/details. */
export function capacityMessage(message: Message) {
  const value = semanticMessage(message);
  return message.role === 'assistant' && !failedModelMessage(message)
    ? { ...value, content: message.content } : value;
}

export function capacityRequest(context: Context) {
  return { ...semanticRequest(context), messages: context.messages.map(capacityMessage) };
}

/** Complete exchanges are atomic inputs to capacity splitting. */
export function semanticExchanges(messages: Message[]) {
  const groups: ReturnType<typeof semanticMessage>[][] = [];
  for (const message of messages) {
    if (message.role === 'toolResult' && groups.length) groups[groups.length - 1].push(semanticMessage(message));
    else groups.push([semanticMessage(message)]);
  }
  return groups;
}
