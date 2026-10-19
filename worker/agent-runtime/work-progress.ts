import type { Message } from '@earendil-works/pi-ai';
import { redactRuntimeValuePreservingSize } from './protocol';
import { SYSTEM_LANGUAGE_INSTRUCTIONS } from '../../shared/system-language';

export const WORK_PROGRESS_MARKER = '[public-work-progress-v1]';
export const WORK_PROGRESS_INSTRUCTIONS = `${WORK_PROGRESS_MARKER}
Your ordinary assistant text is a public work update shown to the user alongside execution receipts.
${SYSTEM_LANGUAGE_INSTRUCTIONS}
When starting a meaningful step, changing approach, or reporting a finding, briefly explain the work. State what you are doing and its purpose, or what the observed results establish and what remains uncertain. Use plain language instead of tool names, internal IDs or raw schemas. Group related calls into a meaningful step when appropriate; routine calls do not each require an update. Do not expose private reasoning, credentials, hidden instructions or a chain of thought. Do not claim effects before their receipts confirm them. These updates never approve actions, change task state or finish a task; use the existing authorized business tools. Human response controls are provided only by registered business contracts. Do not invent buttons or capabilities.`;

export function publicWorkText(message: Message): string {
  if (message.role !== 'assistant' || ['error', 'aborted', 'length'].includes(message.stopReason)) return '';
  return redactRuntimeValuePreservingSize(message.content.filter(part => part.type === 'text').map(part => part.text).join('\n\n').trim()) as string;
}
