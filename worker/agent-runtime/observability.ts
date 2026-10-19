import type { D1Database } from '@cloudflare/workers-types';
import { runtimeJson } from './protocol';
import { classifyRuntimeModelFailure } from './model-errors';

function safeMessage(error: unknown): string {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const cause = value.cause && typeof value.cause === 'object' ? value.cause as Record<string, unknown> : {};
  const message = [
    error instanceof Error ? error.message : String(error),
    cause.message ? String(cause.message) : '',
  ].filter(Boolean).join(' | ');
  return runtimeJson({ message }).slice(12, -2).slice(0, 2000);
}

async function runtimeRunExists(db: D1Database, runId: string): Promise<boolean> {
  return Boolean(await db.prepare('select id from agent_runs where id = ?').bind(runId).first<{ id: string }>());
}

export type RuntimeToolCallState = {
  id: string;
  status: string;
  output: unknown;
};

export async function readRuntimeToolCall(
  db: D1Database,
  runId: string,
  key: string,
): Promise<RuntimeToolCallState | null> {
  const id = `${runId}:${key}`;
  const row = await db.prepare(
    'select id, status, output_json from agent_tool_calls where id = ?',
  ).bind(id).first<{ id: string; status: string; output_json: string }>();
  if (!row) return null;
  let output: unknown = {};
  try { output = JSON.parse(row.output_json || '{}'); } catch { output = {}; }
  return { id: row.id, status: row.status, output };
}

export async function beginRuntimeToolCall(db: D1Database, input: {
  runId: string; key: string; name: string; version?: number; capability: string;
  toolInput?: unknown; retryable?: boolean;
}): Promise<RuntimeToolCallState> {
  const id = `${input.runId}:${input.key}`;
  const startedAt = new Date().toISOString();
  await db.prepare(
    `insert or ignore into agent_tool_calls
     (id, run_id, tool_call_key, tool_name, tool_version, capability, status, input_json, output_json,
      error, retryable, duration_ms, started_at, finished_at)
     values (?, ?, ?, ?, ?, ?, 'running', ?, '{}', '', ?, 0, ?, '')`,
  ).bind(
    id, input.runId, input.key, input.name, input.version || 1, input.capability,
    runtimeJson(input.toolInput || {}), input.retryable ? 1 : 0, startedAt,
  ).run();
  return (await readRuntimeToolCall(db, input.runId, input.key)) || { id, status: 'running', output: {} };
}

export async function recordRuntimeToolProgress(
  db: D1Database,
  id: string,
  output: unknown,
): Promise<void> {
  await db.prepare(
    "update agent_tool_calls set output_json = ? where id = ? and status = 'running'",
  ).bind(runtimeJson(output), id).run();
}

export async function completeRuntimeToolCall(
  db: D1Database,
  id: string,
  output: unknown,
): Promise<void> {
  const finishedAt = new Date().toISOString();
  await db.prepare(
    `update agent_tool_calls set status = 'succeeded', output_json = ?, error = '',
       duration_ms = max(0, cast((julianday(?) - julianday(started_at)) * 86400000 as integer)), finished_at = ?
     where id = ? and status != 'succeeded'`,
  ).bind(runtimeJson(output), finishedAt, finishedAt, id).run();
}

export async function failRuntimeToolCall(
  db: D1Database,
  id: string,
  error: unknown,
): Promise<void> {
  const finishedAt = new Date().toISOString();
  await db.prepare(
    `update agent_tool_calls set status = 'failed', error = ?,
       duration_ms = max(0, cast((julianday(?) - julianday(started_at)) * 86400000 as integer)), finished_at = ?
     where id = ? and status = 'running'`,
  ).bind(safeMessage(error), finishedAt, finishedAt, id).run();
}

export async function failRunningRuntimeTools(
  db: D1Database,
  runId: string,
  error: unknown,
): Promise<void> {
  const finishedAt = new Date().toISOString();
  await db.prepare(
    `update agent_tool_calls set status = 'failed', error = ?,
       duration_ms = max(0, cast((julianday(?) - julianday(started_at)) * 86400000 as integer)), finished_at = ?
     where run_id = ? and status = 'running'`,
  ).bind(safeMessage(error), finishedAt, finishedAt, runId).run();
}

export async function traceRuntimeTool<T>(db: D1Database, input: {
  runId: string; key: string; name: string; version?: number; capability: string;
  toolInput?: unknown; retryable?: boolean;
}, execute: () => Promise<T>): Promise<T> {
  if (!await runtimeRunExists(db, input.runId)) return execute();
  const id = `${input.runId}:${input.key}`;
  const existing = await db.prepare(
    'select status, output_json from agent_tool_calls where id = ?',
  ).bind(id).first<{ status: string; output_json: string }>();
  if (existing?.status === 'succeeded') return JSON.parse(existing.output_json) as T;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  await db.prepare(
    `insert into agent_tool_calls
     (id, run_id, tool_call_key, tool_name, tool_version, capability, status, input_json, output_json,
      error, retryable, duration_ms, started_at, finished_at)
     values (?, ?, ?, ?, ?, ?, 'running', ?, '{}', '', ?, 0, ?, '')`
    + ` on conflict(id) do update set status = 'running', input_json = excluded.input_json,
        error = '', started_at = excluded.started_at, finished_at = ''`,
  ).bind(
    id, input.runId, input.key, input.name, input.version || 1, input.capability,
    runtimeJson(input.toolInput || {}), input.retryable ? 1 : 0, startedAt,
  ).run();
  try {
    const result = await execute();
    await db.prepare(
      "update agent_tool_calls set status = 'succeeded', output_json = ?, error = '', duration_ms = ?, finished_at = ? where id = ?",
    ).bind(runtimeJson(result), Date.now() - started, new Date().toISOString(), id).run();
    return result;
  } catch (error) {
    await db.prepare(
      "update agent_tool_calls set status = 'failed', error = ?, duration_ms = ?, finished_at = ? where id = ?",
    ).bind(safeMessage(error), Date.now() - started, new Date().toISOString(), id).run();
    throw error;
  }
}

function runUsageStatement(db: D1Database, runId: string) {
  return db.prepare(
    `update agent_runs set
       input_tokens = coalesce((select sum(input_tokens) from agent_model_attempts where run_id = ?),
         (select sum(input_tokens) from agent_model_calls where run_id = ?), 0),
       output_tokens = coalesce((select sum(output_tokens) from agent_model_attempts where run_id = ?),
         (select sum(output_tokens) from agent_model_calls where run_id = ?), 0),
       cost_usd = coalesce((select sum(cost_usd) from agent_model_attempts where run_id = ?),
         (select sum(cost_usd) from agent_model_calls where run_id = ?), 0),
       updated_at = ?
     where id = ?`,
  ).bind(runId, runId, runId, runId, runId, runId, new Date().toISOString(), runId);
}
async function aggregateRunUsage(db: D1Database, runId: string): Promise<void> {
  await runUsageStatement(db, runId).run();
}

function failedModelUsage(error: unknown): {
  inputTokens: number; outputTokens: number; costUsd: number; requestId: string; finishReason: string;
} {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const meta = value.modelCallMeta && typeof value.modelCallMeta === 'object'
    ? value.modelCallMeta as Record<string, unknown>
    : {};
  const usage = value.usage && typeof value.usage === 'object' ? value.usage as Record<string, unknown> : {};
  const response = value.response && typeof value.response === 'object' ? value.response as Record<string, unknown> : {};
  const tokenCount = (entry: unknown) => {
    const total = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).total : entry;
    const parsed = Number(total || 0);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  };
  const finish = meta.finishReason || value.finishReason || '';
  const finishReason = finish && typeof finish === 'object'
    ? String((finish as Record<string, unknown>).unified || (finish as Record<string, unknown>).raw || '')
    : String(finish);
  return {
    inputTokens: Math.max(0, Number(meta.inputTokens || 0)) || tokenCount(usage.inputTokens ?? usage.promptTokens),
    outputTokens: Math.max(0, Number(meta.outputTokens || 0)) || tokenCount(usage.outputTokens ?? usage.completionTokens),
    costUsd: Math.max(0, Number(meta.costUsd || 0)),
    requestId: String(meta.requestId || response.id || '').slice(0, 200),
    finishReason: finishReason.slice(0, 100),
  };
}

function modelCompletionDiagnostic(result: unknown): {
  finish_reason: string; tool_call_count: number; text_length: number;
} {
  const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const finish = value.finishReason ?? value.stopReason;
  const finishReason = finish && typeof finish === 'object'
    ? String((finish as Record<string, unknown>).unified || (finish as Record<string, unknown>).raw || '')
    : String(finish || '');
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const toolCallCount = steps.reduce((count, step) => {
    const row = step && typeof step === 'object' ? step as Record<string, unknown> : {};
    return count + (Array.isArray(row.toolCalls) ? row.toolCalls.length : 0);
  }, 0);
  return {
    finish_reason: finishReason.slice(0, 100),
    tool_call_count: toolCallCount,
    text_length: typeof value.text === 'string' ? value.text.length : 0,
  };
}

function attachModelCallMeta(error: unknown, input: {
  inputTokens?: number; outputTokens?: number; costUsd?: number; requestId?: string; finishReason?: string;
}): unknown {
  if (!error || typeof error !== 'object') return error;
  const value = error as Record<string, unknown>;
  const prior = value.modelCallMeta && typeof value.modelCallMeta === 'object'
    ? value.modelCallMeta as Record<string, unknown>
    : {};
  try {
    value.modelCallMeta = { ...prior, ...input };
    return error;
  } catch {
    return Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
      name: error instanceof Error ? error.name : 'RuntimeModelOutputError',
      cause: error,
      modelCallMeta: { ...prior, ...input },
    });
  }
}

function modelResultJson(value: unknown): string {
  const secretResultKey = /^(authorization|cookie|password|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key)$/i;
  const visit = (item: unknown, depth = 0): unknown => {
    if (depth > 20) throw new Error('Runtime model result exceeds the maximum nesting depth');
    if (typeof item === 'string') {
      return item
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
        .replace(/\b(?:sk|tvly)-[A-Za-z0-9_-]{12,}/g, '[redacted]');
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, entry]) => [
        key,
        secretResultKey.test(key)
          ? '[redacted]'
          : visit(entry, depth + 1),
      ]));
    }
    return item;
  };
  const json = JSON.stringify(visit(value));
  if (typeof json !== 'string') throw new Error('Runtime model result must be JSON serializable');
  if (json.length > 256_000) throw new Error('Runtime model result exceeds the 256000 byte persistence limit');
  return json;
}

export async function traceRuntimeModelAttempt<T>(db: D1Database, input: {
  runId: string;
  purpose?: string;
  physicalId?: string;
  decisionTurn: number;
  attempt: number;
  provider: string;
  model: string;
  verifiedRun?: boolean;
  usage?: (result: T) => { inputTokens?: number; outputTokens?: number; costUsd?: number; requestId?: string };
}, execute: () => Promise<T>): Promise<T> {
  if (!input.verifiedRun && !await runtimeRunExists(db, input.runId)) return execute();
  const purpose = input.physicalId ? `${input.purpose || 'decision'}::${input.physicalId}` : input.purpose || 'decision';
  const id = `${input.runId}:model-attempt:${purpose}:${input.decisionTurn}:${input.attempt}`;
  const createdAt = new Date().toISOString();
  const started = Date.now();
  await db.prepare(
    `insert into agent_model_attempts
     (id, run_id, purpose, decision_turn, attempt, provider, model, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, 'running', ?)
     on conflict(run_id, purpose, decision_turn, attempt) do update set
       provider = excluded.provider, model = excluded.model, status = 'running', error_kind = '', error = '',
       created_at = excluded.created_at, finished_at = ''`,
  ).bind(id, input.runId, purpose, input.decisionTurn, input.attempt, input.provider, input.model, createdAt).run();
  try {
    const result = await execute();
    const usage = input.usage?.(result) || {};
    const diagnostic = modelCompletionDiagnostic(result);
    const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    const providerMetadata = value.providerMetadata && typeof value.providerMetadata === 'object'
      ? value.providerMetadata as Record<string, unknown>
      : {};
    const openrouter = providerMetadata.openrouter && typeof providerMetadata.openrouter === 'object'
      ? providerMetadata.openrouter as Record<string, unknown>
      : {};
    const providerUsage = openrouter.usage && typeof openrouter.usage === 'object'
      ? openrouter.usage as Record<string, unknown>
      : {};
    const failedResponse = ['error','aborted'].includes(String(value.stopReason || ''));
    const responseError = failedResponse ? new Error(String(value.errorMessage || value.stopReason)) : null;
    await db.batch([db.prepare(
      `update agent_model_attempts set status = ?, input_tokens = ?, output_tokens = ?,
         text_tokens = ?, reasoning_tokens = ?, cost_usd = ?, duration_ms = ?, request_id = ?,
         finish_reason = ?, actual_provider = ?, error_kind=?, error=?, finished_at = ? where id = ?`,
    ).bind(
      failedResponse ? 'failed' : 'succeeded',
      Math.max(0, Number(usage.inputTokens || 0)), Math.max(0, Number(usage.outputTokens || 0)),
      Math.max(0, Number(providerUsage.completion_tokens_details && (providerUsage.completion_tokens_details as Record<string, unknown>).text_tokens || 0)),
      Math.max(0, Number(providerUsage.completion_tokens_details && (providerUsage.completion_tokens_details as Record<string, unknown>).reasoning_tokens || 0)),
      Math.max(0, Number(usage.costUsd || 0)), Date.now() - started, String(usage.requestId || '').slice(0, 200),
      diagnostic.finish_reason, String(openrouter.provider || '').slice(0, 100), responseError ? classifyRuntimeModelFailure(responseError).kind : '', responseError ? safeMessage(responseError) : '', new Date().toISOString(), id,
    ), runUsageStatement(db, input.runId)]);
    return result;
  } catch (error) {
    const failure = classifyRuntimeModelFailure(error);
    const usage = failedModelUsage(error);
    await db.batch([db.prepare(
      `update agent_model_attempts set status = 'failed', input_tokens = ?, output_tokens = ?, cost_usd = ?,
         duration_ms = ?, request_id = ?, finish_reason = ?, error_kind = ?, error = ?, finished_at = ? where id = ?`,
    ).bind(
      usage.inputTokens, usage.outputTokens, usage.costUsd, Date.now() - started, usage.requestId,
      failure.finishReason || '', failure.kind, safeMessage(error), new Date().toISOString(), id,
    ), runUsageStatement(db, input.runId)]);
    throw error;
  }
}

/**
 * Names the model-attempt trace for one decision.
 *
 * `agent_model_attempts` is unique on (run_id, purpose, decision_turn, attempt)
 * and has no scope column. An Agent running one loop per locale restarts the
 * turn counter each time, so without the scope in `purpose` the second scope
 * would overwrite the first scope's attempt rows — losing the trace and making
 * `assertModelCallCapacity` undercount the Run's real model calls.
 */
export function decisionPurpose(executionScope: string, purpose = 'decision'): string {
  return executionScope ? `${purpose}@${executionScope}` : purpose;
}

export function parseDecisionPurpose(value: string): { purpose: string; executionScope: string } {
  const at = value.indexOf('@');
  return at === -1
    ? { purpose: value, executionScope: '' }
    : { purpose: value.slice(0, at), executionScope: value.slice(at + 1) };
}

export async function persistRuntimeModelDecision(db: D1Database, input: {
  runId: string; turn: number; provider: string; model: string; result: unknown;
  executionScope?: string; verifiedRun?: boolean; providerAttempts?: number; structuralRepairs?: number;
}): Promise<void> {
  if (!input.verifiedRun && !await runtimeRunExists(db, input.runId)) return;
  const executionScope = input.executionScope || '';
  const createdAt = new Date().toISOString();
  const resultJson = modelResultJson(input.result);
  const decision = db.prepare(
    `insert into agent_decision_results
     (id, run_id, execution_scope, turn, provider, model, result_json, created_at, provider_attempts, structural_repairs)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(run_id, execution_scope, turn) do update set provider = excluded.provider,
       model = excluded.model, result_json = excluded.result_json, created_at = excluded.created_at,
       provider_attempts = excluded.provider_attempts, structural_repairs = excluded.structural_repairs`,
  ).bind(
    `${input.runId}:decision:${executionScope}:${input.turn}`, input.runId, executionScope,
    input.turn, input.provider, input.model, resultJson, createdAt, input.providerAttempts ?? null, input.structuralRepairs ?? null,
  );
  // Unscoped decisions keep their legacy row so an older Worker can still
  // replay an in-flight Run during a rollback. Scoped decisions cannot: the
  // legacy unique key would make two scopes overwrite each other.
  if (executionScope) { await decision.run(); return; }
  const id = `${input.runId}:model:${input.turn}`;
  const legacy = db.prepare(
    `insert into agent_model_calls
     (id, run_id, turn, provider, model, status, input_tokens, output_tokens, cost_usd,
      duration_ms, request_id, error, created_at, result_json)
     values (?, ?, ?, ?, ?, 'succeeded', 0, 0, 0, 0, '', '', ?, ?)
     on conflict(run_id, turn) do update set status = 'succeeded', provider = excluded.provider,
       model = excluded.model, error = '', created_at = excluded.created_at, result_json = excluded.result_json`,
  ).bind(id, input.runId, input.turn, input.provider, input.model, createdAt, resultJson);
  await db.batch([decision, legacy]);
}

export function modelUsageFromAiSdk(result: unknown): {
  inputTokens: number; outputTokens: number; costUsd: number; requestId: string;
} {
  const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const usage = value.usage && typeof value.usage === 'object' ? value.usage as Record<string, unknown> : {};
  const response = value.response && typeof value.response === 'object' ? value.response as Record<string, unknown> : {};
  const provider = value.providerMetadata && typeof value.providerMetadata === 'object'
    ? value.providerMetadata as Record<string, unknown>
    : {};
  const openrouter = provider.openrouter && typeof provider.openrouter === 'object'
    ? provider.openrouter as Record<string, unknown>
    : {};
  const providerUsage = openrouter.usage && typeof openrouter.usage === 'object'
    ? openrouter.usage as Record<string, unknown>
    : {};
  const tokenCount = (primary: unknown, fallback: unknown) => {
    const value = primary && typeof primary === 'object'
      ? (primary as Record<string, unknown>).total
      : primary;
    const parsed = Number(value ?? fallback ?? 0);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  };
  return {
    inputTokens: tokenCount(usage.inputTokens ?? usage.promptTokens, providerUsage.prompt_tokens),
    outputTokens: tokenCount(usage.outputTokens ?? usage.completionTokens, providerUsage.completion_tokens),
    costUsd: Math.max(0, Number(openrouter.cost ?? providerUsage.cost ?? 0)),
    requestId: String(response.id || openrouter.requestId || '').slice(0, 200),
  };
}

export async function traceRuntimeModel<T>(db: D1Database, input: {
  runId: string; turn: number; provider: string; model: string;
  usage?: (result: T) => { inputTokens?: number; outputTokens?: number; costUsd?: number; requestId?: string };
  result?: (result: T) => unknown;
}, execute: () => Promise<T>): Promise<T> {
  if (!await runtimeRunExists(db, input.runId)) return execute();
  const id = `${input.runId}:model:${input.turn}`;
  const started = Date.now();
  let result: T;
  let usage: ReturnType<NonNullable<typeof input.usage>> = {};
  let persistedResult = '{}';
  try {
    result = await execute();
    usage = input.usage?.(result) || {};
  } catch (error) {
    const failedUsage = failedModelUsage(error);
    await db.prepare(
      `insert into agent_model_calls
       (id, run_id, turn, provider, model, status, input_tokens, output_tokens, cost_usd,
        duration_ms, request_id, error, created_at, result_json)
       values (?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, '{}')
       on conflict(run_id, turn) do update set status = excluded.status,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cost_usd = excluded.cost_usd, duration_ms = excluded.duration_ms,
        request_id = excluded.request_id, error = excluded.error, created_at = excluded.created_at,
        result_json = excluded.result_json`,
    ).bind(
      id, input.runId, input.turn, input.provider, input.model,
      failedUsage.inputTokens, failedUsage.outputTokens, failedUsage.costUsd,
      Date.now() - started, failedUsage.requestId, safeMessage(error), new Date().toISOString(),
    ).run();
    await aggregateRunUsage(db, input.runId);
    throw error;
  }
  try {
    persistedResult = modelResultJson(input.result ? input.result(result) : {});
  } catch (error) {
    const diagnostic = modelCompletionDiagnostic(result);
    const enriched = attachModelCallMeta(error, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      requestId: usage.requestId,
      finishReason: diagnostic.finish_reason,
    });
    await db.prepare(
      `insert into agent_model_calls
       (id, run_id, turn, provider, model, status, input_tokens, output_tokens, cost_usd,
        duration_ms, request_id, error, created_at, result_json)
       values (?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(run_id, turn) do update set status = excluded.status,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cost_usd = excluded.cost_usd, duration_ms = excluded.duration_ms,
        request_id = excluded.request_id, error = excluded.error, created_at = excluded.created_at,
        result_json = excluded.result_json`,
    ).bind(
      id, input.runId, input.turn, input.provider, input.model,
      Math.max(0, Number(usage.inputTokens || 0)), Math.max(0, Number(usage.outputTokens || 0)),
      Math.max(0, Number(usage.costUsd || 0)), Date.now() - started, String(usage.requestId || '').slice(0, 200),
      safeMessage(enriched), new Date().toISOString(), modelResultJson({ completion: diagnostic }),
    ).run();
    await aggregateRunUsage(db, input.runId);
    throw enriched;
  }
  await db.prepare(
    `insert into agent_model_calls
     (id, run_id, turn, provider, model, status, input_tokens, output_tokens, cost_usd,
      duration_ms, request_id, error, created_at, result_json)
     values (?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, '', ?, ?)
     on conflict(run_id, turn) do update set status = excluded.status, input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens, cost_usd = excluded.cost_usd, duration_ms = excluded.duration_ms,
      request_id = excluded.request_id, error = '', created_at = excluded.created_at, result_json = excluded.result_json`,
  ).bind(
    id, input.runId, input.turn, input.provider, input.model,
    Math.max(0, Number(usage.inputTokens || 0)), Math.max(0, Number(usage.outputTokens || 0)),
    Math.max(0, Number(usage.costUsd || 0)), Date.now() - started, String(usage.requestId || '').slice(0, 200),
    new Date().toISOString(), persistedResult,
  ).run();
  // If aggregation fails, keep the successful cached result. A Workflow retry can
  // reuse it and repair the aggregate without paying for or changing the model decision.
  await aggregateRunUsage(db, input.runId);
  return result;
}

export async function readRuntimeModelResult<T>(
  db: D1Database, runId: string, turn: number, executionScope = '',
): Promise<T | null> {
  if (!await runtimeRunExists(db, runId)) return null;
  const scoped = await db.prepare(
    'select result_json from agent_decision_results where run_id = ? and execution_scope = ? and turn = ?',
  ).bind(runId, executionScope, turn).first<{ result_json: string }>();
  // Only an unscoped decision may fall back to the legacy table: a scoped read
  // that fell back would replay another scope's decision, which is the bug this
  // table exists to fix.
  const row = scoped?.result_json && scoped.result_json !== '{}'
    ? scoped
    : executionScope
      ? null
      : await db.prepare(
          "select result_json from agent_model_calls where run_id = ? and turn = ? and status = 'succeeded'",
        ).bind(runId, turn).first<{ result_json: string }>();
  if (!row?.result_json || row.result_json === '{}') return null;
  // Recompute from source rows on replay. This is idempotent and repairs a prior
  // success where only the aggregate update failed after result persistence.
  await aggregateRunUsage(db, runId);
  return JSON.parse(row.result_json) as T;
}

export async function listRuntimeModelTrace(db: D1Database, runId: string): Promise<Record<string, unknown>[]> {
  const attempts = await db.prepare(
    `select id, decision_turn as turn, decision_turn, attempt, purpose, provider, model,
            actual_provider, status, input_tokens, output_tokens, text_tokens, reasoning_tokens,
            cost_usd, duration_ms, request_id, finish_reason, error_kind, error, created_at, finished_at
     from agent_model_attempts where run_id = ? order by decision_turn asc, attempt asc`,
  ).bind(runId).all<Record<string, unknown>>();
  if (attempts.results?.length) {
    return attempts.results.map((row) => {
      const { purpose, executionScope } = parseDecisionPurpose(String(row.purpose || 'decision'));
      return { ...row, purpose, execution_scope: executionScope };
    });
  }
  const legacy = await db.prepare(
    `select id, turn, turn as decision_turn, 1 as attempt, 'decision' as purpose, provider, model,
            '' as actual_provider, status, input_tokens, output_tokens, 0 as text_tokens, 0 as reasoning_tokens,
            cost_usd, duration_ms, request_id, '' as finish_reason, '' as error_kind, error, created_at,
            created_at as finished_at
     from agent_model_calls where run_id = ? order by turn asc`,
  ).bind(runId).all<Record<string, unknown>>();
  return legacy.results ?? [];
}

export async function traceRuntimeModelValue<T>(db: D1Database, input: {
  runId: string; turn: number; provider: string; model: string;
  usage?: (result: T) => { inputTokens?: number; outputTokens?: number; costUsd?: number; requestId?: string };
}, execute: () => Promise<T>): Promise<T> {
  const cached = await readRuntimeModelResult<T>(db, input.runId, input.turn);
  if (cached !== null) return cached;
  return traceRuntimeModel(db, { ...input, result: (value) => value }, execute);
}
