import type { AgentShell } from './worker/agent-runtime/shell';

declare global {
interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PUBLISH_WORKFLOW: Workflow;
  LOCALIZE_WORKFLOW: Workflow;
  AGENT_SHELL: DurableObjectNamespace<AgentShell>;
  SITE_ROOM: DurableObjectNamespace<import('./worker/site-room/room').SiteRoom>;
  AGENT_WORKFLOW: Workflow;
  MODEL_REGISTRY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
  DATAFORSEO_LOGIN?: string;
  DATAFORSEO_PASSWORD?: string;
  BROWSER: BrowserRun;
  RESEARCH_BUCKET: R2Bucket;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_NAME?: string;
  AGENT_RUNTIME_ENABLED: string;
  /** @deprecated Management requests always require authentication. */
  APP_AUTH_MODE?: string;
  AUTH_LOGIN_METHODS?: string;
  AUTH_SETUP_TOKEN?: string;
  AUTH_ALLOWED_GOOGLE_EMAIL?: string;
  AUTH_GOOGLE_CLIENT_ID?: string;
  AUTH_GOOGLE_CLIENT_SECRET?: string;
  AUTH_SESSION_SECRET?: string;
  CLOUDFLARE_WORKER_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CNAME_TARGET: string;
  CLOUDFLARE_API_TOKEN?: string;
  // Google OAuth secrets (product-level, set once via wrangler secret put)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // 32-byte hex key for AES-GCM encryption of per-site refresh tokens
  GSC_TOKEN_CIPHER_KEY?: string;
  // IndexNow verification key (8+ char hex, hosted at /{key}.txt)
  INDEXNOW_KEY?: string;
}
}

export {};
