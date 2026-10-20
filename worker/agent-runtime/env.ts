import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { AgentWorkflowStep } from 'agents/workflows';

export type RuntimeWorkflowStep = AgentWorkflowStep;

export type RuntimeWorkflowInstance = {
  id: string;
  status(): Promise<{ status: string; error?: { name: string; message: string }; output?: unknown }>;
  terminate(): Promise<void>;
  sendEvent(event: { type: string; payload: unknown }): Promise<void>;
};

export type RuntimeWorkflowBinding = {
  create(options?: { id?: string; params?: unknown }): Promise<RuntimeWorkflowInstance>;
  get(id: string): Promise<RuntimeWorkflowInstance>;
};

export interface RuntimeAgentEnv {
  execution?: import('./execution-context').RuntimeExecutionContext;
  DB: D1Database;
  recordFirecrawlIdentity?: (taskId: string, jobId: string) => Promise<void>;
  MODEL_REGISTRY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
  FIRECRAWL_RESEARCH_MODEL?: string;
  FIRECRAWL_RESEARCH_MAX_CREDITS?: string;
  RESEARCH_BUCKET?: R2Bucket;
  /** @deprecated Current model profiles use their configured provider endpoint directly. */
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_NAME?: string;
  AGENT_RUNTIME_ENABLED?: string;
  AGENT_WORKFLOW: RuntimeWorkflowBinding;
  AGENT_SHELL: unknown;
  /** Live site rooms (worker/site-room); optional so tests and tools run without it. */
  SITE_ROOM?: import('../site-room/poke').RoomEnv['SITE_ROOM'];
}
