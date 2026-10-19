import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';

/** Feed the saved decision through the SDK once. The host reuses each saved tool receipt.
 * No model request is issued for this decision; subsequent turns use the durable transport. */
export function replayConversationResponse(saved: AssistantMessage, continuation: StreamFn, adapt?: (response: AssistantMessage) => AssistantMessage): StreamFn {
  let pending = true;
  return (model, context, options) => {
    if (!pending) return continuation(model, context, options);
    pending = false;
    const message = adapt ? adapt(structuredClone(saved)) : structuredClone(saved);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      stream.push({ type: 'error', reason: message.stopReason, error: message });
    } else if (message.stopReason === 'pending') {
      stream.push({ type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: 'A pending provider response requires reconciliation before continuing' } });
    } else {
      stream.push({ type: 'done', reason: message.stopReason, message });
    }
    return stream;
  };
}
