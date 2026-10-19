import { runtimeJson } from './protocol';

export type AgentCommandName = 'cancel' | 'resume' | 'retry' | 'approve' | 'reject' | 'provide_input';
export type AgentCommandSource = 'ui' | 'chat' | 'api';
export const AGENT_COMMAND_NAMES: readonly AgentCommandName[] = ['cancel', 'resume', 'retry', 'approve', 'reject', 'provide_input'];

export function isAgentCommandName(value: unknown): value is AgentCommandName {
  return typeof value === 'string' && AGENT_COMMAND_NAMES.includes(value as AgentCommandName);
}

type AgentCommandRow = {
  id: string; run_id: string; command: AgentCommandName; actor_id: string; source: AgentCommandSource;
  status: 'processing' | 'succeeded' | 'failed'; payload_json: string; result_json: string; error: string;
};

function safeCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(JSON.parse(runtimeJson({ message })).message || 'Agent command failed').slice(0, 1000);
}

export function agentCommandFailure(error: unknown): { error: string; status: number } {
  const message = safeCommandError(error);
  if (/Runtime is disabled/i.test(message)) return { error: message, status: 503 };
  if (/not found/i.test(message)) return { error: message, status: 404 };
  if (/identity is invalid|Unknown Agent command/i.test(message)) return { error: message, status: 400 };
  if (/already|collision|Only failed|not waiting|terminal|status/i.test(message)) return { error: message, status: 409 };
  return { error: message, status: 500 };
}

export async function executeAgentCommand<T>(db: D1Database, input: {
  commandId: string; runId: string; command: AgentCommandName; actorId: string;
  source: AgentCommandSource; payload?: unknown;
}, execute: () => Promise<T>, recoverProcessing?: () => Promise<T | null>): Promise<T> {
  if (!input.commandId || !input.runId || !input.actorId) throw new Error('Agent command identity is invalid');
  const at = new Date().toISOString();
  const inserted = await db.prepare(
    `insert or ignore into agent_commands
     (id, run_id, command, actor_id, source, status, payload_json, result_json, error, created_at, finished_at)
     values (?, ?, ?, ?, ?, 'processing', ?, '{}', '', ?, '')`,
  ).bind(
    input.commandId, input.runId, input.command, input.actorId, input.source,
    runtimeJson(input.payload || {}), at,
  ).run();
  if (!inserted.meta.changes) {
    const existing = await db.prepare('select * from agent_commands where id = ?')
      .bind(input.commandId)
      .first<AgentCommandRow>();
    if (!existing || existing.run_id !== input.runId || existing.command !== input.command || existing.actor_id !== input.actorId) {
      throw new Error('Agent command idempotency key collision');
    }
    if (existing.status === 'succeeded') return JSON.parse(existing.result_json) as T;
    if (existing.status === 'failed') throw new Error(existing.error || 'Agent command previously failed');
    if (recoverProcessing) {
      const recovered = await recoverProcessing();
      if (recovered !== null) {
        await db.prepare(
          "update agent_commands set status = 'succeeded', result_json = ?, error = '', finished_at = ? where id = ? and status = 'processing'",
        ).bind(runtimeJson(recovered), new Date().toISOString(), input.commandId).run();
        return recovered;
      }
    }
    throw new Error('Agent command is already processing');
  }
  try {
    const result = await execute();
    await db.prepare(
      "update agent_commands set status = 'succeeded', result_json = ?, error = '', finished_at = ? where id = ? and status = 'processing'",
    ).bind(runtimeJson(result), new Date().toISOString(), input.commandId).run();
    return result;
  } catch (error) {
    const message = safeCommandError(error);
    await db.prepare(
      "update agent_commands set status = 'failed', error = ?, finished_at = ? where id = ? and status = 'processing'",
    ).bind(message, new Date().toISOString(), input.commandId).run();
    throw error;
  }
}

export async function agentCommandWasApplied(db: D1Database, input: {
  runId: string; commandId: string; command: Exclude<AgentCommandName, 'retry' | 'resume'>; actorId: string;
}): Promise<boolean> {
  if (input.command === 'cancel') {
    const run = await db.prepare('select status from agent_runs where id = ?').bind(input.runId).first<{ status: string }>();
    return run?.status === 'cancelled';
  }
  if (input.command === 'provide_input') {
    return Boolean(await db.prepare('select id from agent_events where run_id = ? and event_key = ?')
      .bind(input.runId, `input.provided:${input.commandId}`).first<{ id: string }>());
  }
  const approval = await db.prepare(
    'select status, decided_by from agent_approvals where run_id = ? order by requested_at desc limit 1',
  ).bind(input.runId).first<{ status: string; decided_by: string }>();
  return approval?.status === (input.command === 'approve' ? 'approved' : 'rejected') && approval.decided_by === input.actorId;
}

export function chatMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const value = message as { role?: unknown; parts?: unknown };
  if (value.role !== 'user' || !Array.isArray(value.parts)) return '';
  return value.parts
    .filter((part): part is { type: 'text'; text: string } => Boolean(
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string',
    ))
    .map((part) => part.text)
    .join('\n')
    .slice(0, 8000);
}

export function assertExplicitChatControl(text: string, command: Exclude<AgentCommandName, 'retry' | 'resume'>): void {
  const patterns: Record<Exclude<AgentCommandName, 'retry' | 'resume'>, RegExp> = {
    cancel: /(?:\u53d6\u6d88|\u4e2d\u65ad|\u505c\u6b62|\bcancel\b|\bstop\b)/i,
    approve: /(?:\u6279\u51c6|\u540c\u610f|\u7ee7\u7eed\u6267\u884c|\bapprove\b)/i,
    reject: /(?:\u62d2\u7edd|\u4e0d\u8981\u6267\u884c|\breject\b)/i,
    provide_input: /(?:\u8865\u5145|\u8f93\u5165|\u63d0\u4f9b|\bprovide\b|\binput\b)/i,
  };
  if (!patterns[command].test(text)) throw new Error(`Latest user message does not explicitly request ${command}`);
}
