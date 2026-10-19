import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { D1Database } from '@cloudflare/workers-types';
import type { AgentTask } from './task-store';
import { readConversation } from './conversation-store';
import { calibratedRequestCapacity } from './request-calibration';

/** Storage pages and the final request use the same capacity authority. */
export function readModelConversation(db: D1Database, task: AgentTask, model: Model<Api>, tools: Context['tools']) {
  return readConversation(db, task, {
    maxReadTokens: model.contextWindow,
    remainingReadTokens: async view => {
      const capacity = await calibratedRequestCapacity({ systemPrompt: view.instructions, messages: view.messages, tools }, model);
      return capacity.availableInputTokens - capacity.estimatedInputTokens;
    },
  });
}
