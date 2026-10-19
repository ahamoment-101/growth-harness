import type { Message } from '@earendil-works/pi-ai';
import type { AgentDefinition } from './definitions';

/** All durable result append paths share this projection, including recovery.
 * Hash the complete receipt so a hidden change cannot reuse a message identity. */
export async function toolResultView(message: Message, views: AgentDefinition['toolResultViews'], contract: number): Promise<Message> {
  if (message.role !== 'toolResult' || message.isError) return message;
  const project = views?.[contract]?.[message.toolName];
  if (!project) return message;
  if (message.content.length !== 1 || message.content[0].type !== 'text') throw new Error('Projected tool result requires one JSON receipt');
  const text = message.content[0].text;
  const view = project(JSON.parse(text));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  return { ...message, content: [{ type: 'text', text: JSON.stringify({
    ...view as Record<string, unknown>, receipt_integrity: { algorithm: 'sha256', digest },
  }) }] };
}
