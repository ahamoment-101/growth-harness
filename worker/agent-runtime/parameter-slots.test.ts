import { describe, it, expect } from 'vitest';
import { taskTestDb } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, beginTaskDecision, setTaskAction } from './task-store';
import { saveSlot, resolveSlot, bindOperation } from './parameter-slots';

describe('durable parameter references', () => {
  it('keeps large observed context and resolved inputs outside D1 row payload limits', async () => {
    const { db, run } = taskTestDb();
    const task = await attachTask(db, run(), agentDefinition('strategy_research'));
    const value = { document: 'Complete business documentation 🙂'.repeat(20000), version: 4 };
    const ref = await saveSlot(db, task, 'language_context', value);
    expect(await resolveSlot(db, task, ref, 'language_context')).toEqual(value);
    expect(await db.prepare('select length(value_json) as n from agent_parameter_slots').first<number>('n')).toBeLessThan(1000);
    const op = await beginTaskDecision(db, task, {});
    await setTaskAction(db, task, op, { name: 'select', input: { ref } });
    expect(await bindOperation(db, task, op, { ref, note: value.document }, async () => value)).toEqual(value);
    expect(await bindOperation(db, task, op, { ref, note: value.document }, async () => ({ ...value, version: 5 }))).toEqual(value);
    expect(await db.prepare('select length(resolved_json) as n from agent_operation_bindings').first<number>('n')).toBeLessThan(1000);
  });
  it('preserves immutable observations, rejects other tasks/types and reuses resolved bindings', async () => {
    const { db, run } = taskTestDb();
    const a = await attachTask(db, run(), agentDefinition('strategy_research'));
    const b = await attachTask(db, run('other', 'other'), agentDefinition('strategy_research'));
    const ref = await saveSlot(db, a, 'revision', { version: 4 });
    expect(await saveSlot(db, a, 'revision', { version: 4 })).toBe(ref);
    expect(await resolveSlot(db, a, ref, 'revision')).toEqual({version: 4});
    await expect(resolveSlot(db, b, ref, 'revision')).rejects.toThrow('reference');
    await expect(resolveSlot(db, a, ref, 'source')).rejects.toThrow('reference');
    const op = await beginTaskDecision(db, a, {});
    await setTaskAction(db, a, op, {name: 'test', input: {ref}});
    expect(await bindOperation(db, a, op, {ref}, async () => ({version: 4}))).toEqual({version: 4});
    expect(await bindOperation(db, a, op, {ref}, async () => ({version: 5}))).toEqual({version: 4});
    await expect(bindOperation(db, a, op, {ref: 'different'}, async () => ({}))).rejects.toThrow('binding changed');
  });
});

it('rejects a tool exposing a declared host-bound parameter to the model', async () => {
  const { ToolRegistry } = await import('./tools');
  const { z } = await import('zod');
  expect(() => new ToolRegistry().register({ name: 'write_other_site', version: 2, description: 'Invalid contract', capability: 'write', replaySafety: 'idempotent', approval: 'never', retryable: false, timeoutMs: 1000,
    parameterBindings: {system: ['site_id'], references: []}, inputSchema: z.object({site_id:z.string()}), outputSchema: z.unknown(), execute: async () => ({}) })).toThrow('Host-bound parameter');
});
