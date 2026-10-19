import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { z } from 'zod';

export type ConversationToolContract = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
};

/** The host supplies authorization, receipts and effects; this adapter only owns schema translation. */
export function conversationTool(
  contract: ConversationToolContract,
  execute: (callId: string, input: unknown, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>,
): AgentTool {
  return {
    name: contract.name,
    label: contract.name,
    description: contract.description,
    parameters: z.toJSONSchema(contract.inputSchema, { io: 'input' }) as AgentTool['parameters'],
    // Pi coerces primitives during schema validation. Reject invalid raw values first:
    // null must not become "", false or 0 unless the domain schema explicitly permits it.
    prepareArguments: input => { contract.inputSchema.parse(input); return input; },
    execute: (callId, input, signal) => execute(callId, contract.inputSchema.parse(input), signal),
  };
}
