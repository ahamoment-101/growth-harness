export const AGENT_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_input',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export type AgentActorType = 'system' | 'user' | 'agent' | 'workflow' | 'tool';

export type AgentRun = {
  execution_outcome?: string;
  execution_failure_json?: string;
  id: string;
  workspace_id: string;
  site_id: string;
  agent_id: string;
  agent_instance_id: string;
  definition_version: number;
  prompt_version: string;
  trigger: string;
  schedule_key: string;
  status: AgentRunStatus;
  phase: string;
  workflow_id: string;
  root_run_id: string;
  parent_run_id: string;
  retry_of_run_id: string;
  context_snapshot_id: string;
  event_seq: number;
  summary_json: string;
  output_json: string;
  error_code: string;
  error: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  started_at: string;
  finished_at: string;
  created_at: string;
  updated_at: string;
};

export type AgentEvent = {
  id: string;
  run_id: string;
  seq: number;
  event_key: string;
  kind: string;
  phase: string;
  actor_type: AgentActorType;
  actor_id: string;
  payload_json: string;
  created_at: string;
};

const TRANSITIONS: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['waiting_for_approval', 'waiting_for_input', 'succeeded', 'failed', 'cancelled'],
  waiting_for_approval: ['running', 'failed', 'cancelled'],
  waiting_for_input: ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransitionAgentRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

const SECRET_KEY = /(authorization|cookie|password|secret|token|refresh|api[_-]?key)/i;

export function redactRuntimeValuePreservingSize(value: unknown, depth = 0): unknown {
  if (depth > 50) throw new Error('Runtime value exceeds the maximum nesting depth');
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk|fc|tvly)-[A-Za-z0-9_-]{12,}/g, '[redacted]');
  }
  if (Array.isArray(value)) return value.map((item) => redactRuntimeValuePreservingSize(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? '[redacted]' : redactRuntimeValuePreservingSize(item, depth + 1),
    ]));
  }
  return value;
}

/**
 * Redacts and bounds a value for logs, events and errors.
 *
 * Text cuts announce themselves: a bare `[truncated]` marker reads to a model
 * exactly like a field that was genuinely empty, so string and depth limits now
 * say what was removed. Structural limits stay silent on purpose — see below.
 * Model-visible tool output should not be shortened by this at all; that is
 * what `preserveOutputSize` is for.
 */
export function redactRuntimeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated: nested beyond depth 8]';
  if (typeof value === 'string') {
    const redacted = value
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk|fc|tvly)-[A-Za-z0-9_-]{12,}/g, '[redacted]');
    return redacted.length <= 4000
      ? redacted
      : `${redacted.slice(0, 4000)}…[truncated ${redacted.length - 4000} chars]`;
  }
  // Arrays and objects are bounded but not annotated. A marker element or key
  // would be a value of the wrong type inside a structure that callers read as
  // typed data — `fetch_competitor_sitemap` returns up to 120 pages, and a
  // string sitting among `{url, title}` records is a defect waiting for the
  // first consumer that iterates past the first hundred. Anything the model
  // reads directly must set `preserveOutputSize` on its tool instead of relying
  // on this being lossless.
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactRuntimeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? '[redacted]' : redactRuntimeValue(item, depth + 1),
    ]));
  }
  return value;
}

export function runtimeJson(value: unknown, maxLength = 32_000): string {
  const json = JSON.stringify(redactRuntimeValue(value));
  return json.length <= maxLength ? json : JSON.stringify({ truncated: true, preview: json.slice(0, Math.max(0, maxLength - 1000)) });
}
