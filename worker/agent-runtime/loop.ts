import { generateText, hasToolCall, isStepCount, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { AgentDefinition } from './definitions';

export type RuntimeSiteSnapshot = {
  id: string;
  name: string;
  domain: string;
  productBrief: string;
  researchSeedTerms: string[];
  competitorDomains: string[];
};

export type RuntimeToolEvent = {
  tool: string;
  phase: 'started' | 'completed' | 'failed';
  at: string;
  detail: string;
};

type RunRuntimeLoopInput = {
  model: LanguageModel;
  definition: AgentDefinition;
  site: RuntimeSiteSnapshot;
  onToolEvent: (event: RuntimeToolEvent) => Promise<void>;
  startWorkflow: (summary: string) => Promise<string>;
};

export type RuntimeLoopResult = {
  text: string;
  workflowId: string;
  toolCalls: string[];
};

function now() {
  return new Date().toISOString();
}

async function withToolEvent<T>(
  toolName: string,
  detail: string,
  onToolEvent: RunRuntimeLoopInput['onToolEvent'],
  action: () => Promise<T> | T,
): Promise<T> {
  await onToolEvent({ tool: toolName, phase: 'started', at: now(), detail });
  try {
    const result = await action();
    await onToolEvent({ tool: toolName, phase: 'completed', at: now(), detail });
    return result;
  } catch (error) {
    await onToolEvent({
      tool: toolName,
      phase: 'failed',
      at: now(),
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function runRuntimeLoop(input: RunRuntimeLoopInput): Promise<RuntimeLoopResult> {
  const injectedTool = input.definition.injectedTool;
  if (!injectedTool) throw new Error(`${input.definition.id} does not support the legacy Runtime probe loop`);
  let identityRead = false;
  let contextRead = false;
  let workflowId = '';

  const readRuntimeIdentity = tool({
    description: 'Read the Agent identity, mission, and tool boundaries injected by the current router. Call this first.',
    inputSchema: z.object({}),
    execute: async () => withToolEvent(
      'read_runtime_identity',
      input.definition.id,
      input.onToolEvent,
      () => {
        identityRead = true;
        return {
          agent_id: input.definition.id,
          label: input.definition.promptLabel,
          mission: input.definition.mission,
          injected_tool: injectedTool,
        };
      },
    ),
  });

  const readInjectedContext = tool({
    description: `Read the site context injected only for ${input.definition.promptLabel}. Call this before starting durable work.`,
    inputSchema: z.object({}),
    execute: async () => withToolEvent(
      injectedTool,
      input.site.id,
      input.onToolEvent,
      () => {
        contextRead = true;
        return input.definition.id === 'runtime_synthetic'
          ? {
              site: { id: input.site.id, name: input.site.name, domain: input.site.domain },
              synthetic_inputs: {
                fixture: 'synthetic-only',
                expected_action: 'start durable workflow after reading context',
              },
            }
          : {
              site: { id: input.site.id, name: input.site.name, domain: input.site.domain },
              research_inputs: {
                product_brief: input.site.productBrief,
                competitor_domains: input.site.competitorDomains,
                research_seed_terms: input.site.researchSeedTerms,
              },
            };
      },
    ),
  });

  const startDurableProbe = tool({
    description: 'After reading identity and context, start a recoverable Cloudflare Workflow as the terminal action of this autonomous loop.',
    inputSchema: z.object({
      summary: z.string().min(1).max(500).describe('Explain why durable execution should begin now'),
    }),
    execute: async ({ summary }) => withToolEvent(
      'start_durable_probe',
      summary,
      input.onToolEvent,
      async () => {
        if (!identityRead || !contextRead) {
          throw new Error('Agent identity and injected context must be read first');
        }
        workflowId = await input.startWorkflow(summary);
        return { workflow_id: workflowId, accepted: true };
      },
    ),
  });

  const tools = {
    read_runtime_identity: readRuntimeIdentity,
    [injectedTool]: readInjectedContext,
    start_durable_probe: startDurableProbe,
  };

  const result = await generateText({
    model: input.model,
    system: [
      'You are a business Agent running in the generic Agent Runtime.',
      `The router injected agent_id ${input.definition.id}.`,
      'You must call tools yourself to verify identity and context before starting durable work.',
      'Do not pretend to call tools, reveal secrets, or modify business data.',
    ].join('\n'),
    prompt: `Run one ${input.definition.promptLabel} runtime technical verification for site ${input.site.name}.`,
    tools,
    toolChoice: 'required',
    stopWhen: [hasToolCall('start_durable_probe'), isStepCount(7)],
  });

  if (!workflowId) throw new Error('Agent loop did not start a durable Workflow');
  return {
    text: result.text,
    workflowId,
    toolCalls: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
  };
}
