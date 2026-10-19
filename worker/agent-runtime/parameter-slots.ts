import type { D1Database } from '@cloudflare/workers-types';
import type { AgentTask, TaskOperation } from './task-store';
import { requireTask } from './task-store';
import { ToolContractError } from './tool-failure';
import { persistRuntimeJson, readRuntimeJson } from './runtime-content';

function invalid(path: string, message: string): never {
  throw new ToolContractError(message, { kind: 'invalid_request', effects: 'none',
    issues: [{ path: [path], message }], guidance: 'Read the available references and select an existing reference of the required type. Do not reconstruct identities or versions.' });
}
/** Immutable task-scoped observations. A reference is a selector, never authorization. */
export function slotBatch(db: D1Database, task: AgentTask) {
  const entries = new Map<string, { kind: string; json: string }>();
  return {
    async add(kind: string, value: unknown): Promise<string> {
      const json = JSON.stringify(value);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([task.id, kind, json])));
      const ref = 'ref-' + Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, '0')).join('');
      entries.set(ref, { kind, json });
      return ref;
    },
    async commit() {
      const current = await requireTask(db, task.active_run_id);
      if (current.epoch !== task.epoch) invalid('execution', 'Execution ownership changed');
      const statements = await Promise.all([...entries].map(async ([ref, value]) => db.prepare(`insert or ignore into agent_parameter_slots(task_id,ref,kind,value_json)
        select ?,?,?,? where exists(select 1 from agent_tasks where id=? and active_run_id=? and epoch=? and status='running'
        and exists(select 1 from agent_tasks root where root.id=agent_tasks.root_task_id and root.status in ('running','waiting','paused')))`)
        .bind(task.id, ref, value.kind, await persistRuntimeJson(db, JSON.parse(value.json)), task.id, task.active_run_id, task.epoch)));
      for (let i = 0; i < statements.length; i += 64) await db.batch(statements.slice(i, i + 64));
      entries.clear();
      const after = await requireTask(db, task.active_run_id);
      if (after.epoch !== task.epoch) invalid('execution', 'Execution ownership changed');
    },
  };
}
export async function saveSlot(db: D1Database, task: AgentTask, kind: string, value: unknown): Promise<string> {
  const batch = slotBatch(db, task); const ref = await batch.add(kind, value); await batch.commit(); return ref;
}
export async function resolveSlot<T>(db: D1Database, task: AgentTask, ref: string, kind: string, path = kind): Promise<T> {
  await requireTask(db, task.active_run_id);
  const row = await db.prepare('select value_json from agent_parameter_slots where task_id=? and ref=? and kind=?')
    .bind(task.id, ref, kind).first<{ value_json: string }>();
  if (!row) invalid(path, 'Unknown, out-of-scope or wrong-type reference');
  return readRuntimeJson<T>(db, row.value_json);
}
/** Resolve once before effects; replay cannot bind an old model decision to newer state. */
export async function bindOperation<T>(db: D1Database, task: AgentTask, operation: TaskOperation, input: unknown, resolve: () => Promise<T>): Promise<T> {
  await requireTask(db, task.active_run_id);
  const inputJson = JSON.stringify(input);
  const read = () => db.prepare('select input_json,resolved_json from agent_operation_bindings where operation_id=? and task_id=?')
    .bind(operation.id, task.id).first<{input_json: string; resolved_json: string}>();
  let row = await read();
  if (!row) {
    const resolved = await resolve();
    await db.prepare(`insert or ignore into agent_operation_bindings(operation_id,task_id,input_json,resolved_json)
      select ?,?,?,? where exists(select 1 from agent_tasks t join agent_task_operations o on o.task_id=t.id
      where t.id=? and t.active_run_id=? and t.epoch=? and t.status='running' and o.id=? and o.turn=t.next_turn)`)
      .bind(operation.id, task.id, await persistRuntimeJson(db, input), await persistRuntimeJson(db, resolved), task.id, task.active_run_id, task.epoch, operation.id).run();
    row = await read();
  }
  if (!row || JSON.stringify(await readRuntimeJson(db, row.input_json)) !== inputJson) invalid('input', 'Operation binding changed or execution ownership was lost');
  return readRuntimeJson<T>(db, row.resolved_json);
}
