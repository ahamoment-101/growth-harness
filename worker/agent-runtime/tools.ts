import { z } from 'zod';
import type { AgentDefinition } from './definitions';
import { redactRuntimeValue, redactRuntimeValuePreservingSize } from './protocol';

export type ToolCapability = 'read' | 'write' | 'external' | 'destructive';
export type ToolCompletion = { status: 'completed' | 'waiting' | 'paused'; outcome: string; reason: string; output: unknown };
export type RuntimeToolContext = {
  execution?: import('./execution-context').RuntimeExecutionContext;
  runId: string;
  workspaceId: string;
  siteId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
};

export type RuntimeTool<Input = unknown, Output = unknown> = {
  name: string;
  /** Domain declarations for model selectors; execution identities stay host-bound. */
  parameterBindings?: { system: string[]; references: string[] };
  version: number;
  description: string;
  capability: ToolCapability;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  timeoutMs: number;
  retryable: boolean;
  /** What a started call means when its host ends before the receipt is saved. Required unless capability is read.
   * repeatable: no business effect, so it runs again. idempotent: repeating converges on the same effect.
   * unreconciled: repeating could duplicate an effect and no reconciliation exists, so the operation blocks resumption. */
  replaySafety?: 'repeatable' | 'idempotent' | 'unreconciled';
  approval: 'never' | 'required';
  executionMode?: 'inline' | 'durable_async' | 'durable_call';
  preserveOutputSize?: boolean;
  /** Domain-owned interpretation; the Runtime commits this outcome and stops subsequent effects. */
  completion?: (output: Output) => ToolCompletion | undefined;
  execute?: (input: Input, context: RuntimeToolContext) => Promise<Output>;
};

function validateParameterBindings(tool: RuntimeTool) {
  if (!tool.parameterBindings) return; // Historical tool contracts predate declarations.
  const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' });
  const properties = schema.properties || {};
  for (const field of tool.parameterBindings.system) {
    if (Object.prototype.hasOwnProperty.call(properties, field)) throw new Error(`Host-bound parameter ${field} cannot be model input for ${tool.name}`);
  }
}

function validateEffectContract(tool: RuntimeTool) {
  if (tool.capability !== 'read' && !tool.replaySafety) throw new Error(`Tool ${tool.name} must declare its interrupted-effect contract`);
}

/** Whether a call interrupted before its receipt may execute again in a later host. */
export function replaysAfterInterruption(tool: Pick<RuntimeTool, 'capability' | 'replaySafety'>): boolean {
  return tool.capability === 'read' || tool.replaySafety === 'repeatable' || tool.replaySafety === 'idempotent';
}

export class ToolRegistry {
  constructor(private readonly beforeExecute?: () => void) {}
  private readonly tools = new Map<string, RuntimeTool>();

  register<Input, Output>(tool: RuntimeTool<Input, Output>): this {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name) || tool.version < 1) throw new Error('Tool identity is invalid');
    if (this.tools.has(tool.name)) throw new Error(`Tool is already registered: ${tool.name}`);
    if (tool.capability === 'destructive' && tool.approval !== 'required') throw new Error('Destructive tools require approval');
    validateEffectContract(tool as RuntimeTool);
    validateParameterBindings(tool as RuntimeTool);
    this.tools.set(tool.name, tool as RuntimeTool);
    return this;
  }

  resolve(definition: AgentDefinition, name: string): RuntimeTool {
    if (!definition.tools.includes(name)) throw new Error(`Tool is not allowed for ${definition.id}: ${name}`);
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool is not registered: ${name}`);
    return tool;
  }

  mapTools(transform: (tool: RuntimeTool) => RuntimeTool): this {
    for (const [name, tool] of this.tools) {
      const next = transform(tool);
      if (next.name !== name) throw new Error('Tool mapping cannot change identity');
      validateEffectContract(next);
      validateParameterBindings(next);
      this.tools.set(name, next);
    }
    return this;
  }

  names(): string[] { return [...this.tools.keys()]; }

  async execute(definition: AgentDefinition, name: string, input: unknown, context: RuntimeToolContext): Promise<unknown> {
    this.beforeExecute?.();
    const tool = this.resolve(definition, name);
    if (tool.approval === 'required') throw new Error(`Tool requires approval: ${name}`);
    if (tool.executionMode === 'durable_async') throw new Error(`Tool requires durable async execution: ${name}`);
    if (!tool.execute) throw new Error(`Tool has no inline executor: ${name}`);
    const parsed = tool.inputSchema.parse(input);
    // Durable executors own bounded Workflow steps; wrapping the whole sequence
    // in an in-memory timer can abandon a still-running model request.
    if (tool.executionMode === 'durable_call') {
      const result = tool.outputSchema.parse(await tool.execute(parsed, context));
      return tool.preserveOutputSize ? redactRuntimeValuePreservingSize(result) : redactRuntimeValue(result);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Tool timed out: ${name}`)), tool.timeoutMs);
    try {
      const result = await Promise.race([
        tool.execute(parsed, { ...context, signal: controller.signal }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
      ]);
      const parsedResult = tool.outputSchema.parse(result);
      return tool.preserveOutputSize
        ? redactRuntimeValuePreservingSize(parsedResult)
        : redactRuntimeValue(parsedResult);
    } finally {
      clearTimeout(timeout);
    }
  }
}
