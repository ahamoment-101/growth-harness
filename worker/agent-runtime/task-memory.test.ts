import { expect, it } from 'vitest';
import { taskMemoryTool } from './task-memory';
import { saveSlot } from './parameter-slots';
import { taskTestDb } from './task-test-db';
import { attachTask, beginTaskDecision, finishTaskOperation, setTaskAction } from './task-store';
import { agentDefinition } from './definitions';
import type { RuntimeAgentEnv } from './env';

it('recovers exact observed entity versions in pages without exposing another task', async () => {
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const other = await attachTask(f.db, f.run('other', 'strategy:fr'), agentDefinition('strategy_research'));
  const original = { entity: 'candidate-1', observed_version: 7, evidence: 'Evidence 🙂'.repeat(1500) };
  const reference = await saveSlot(f.db, task, 'candidate', original);
  await saveSlot(f.db, task, 'candidate', { entity: 'candidate-1', observed_version: 8 });
  const foreign = await saveSlot(f.db, other, 'candidate', { entity: 'private-child-candidate' });
  for (let index = 0; index < 21; index++) await saveSlot(f.db, task, 'evidence', { index });
  const tool = taskMemoryTool({ DB: f.db } as RuntimeAgentEnv);
  const context = { runId: task.active_run_id, workspaceId: 'w', siteId: 's', idempotencyKey: 'memory-read' };
  const call = async (args: unknown) => await tool.execute!(tool.inputSchema.parse(args), context) as {
    available: boolean; excerpt: string; next_offset: number | null; records: Array<{reference:string}>; next_after: string | null;
  };
  const first = await call({ section: 'observations' });
  const second = await call({ section: 'observations', after: first.next_after });
  expect(first.records).toHaveLength(20);
  expect(second.records).toHaveLength(3);
  expect(new Set([...first.records, ...second.records].map(row => row.reference)).size).toBe(23);
  expect(second.next_after).toBeNull();
  let text = ''; let offset = 0;
  for (;;) {
    const result = await call({ section: 'observations', reference, offset });
    text += result.excerpt;
    if (result.next_offset === null) break;
    offset = result.next_offset;
  }
  expect(JSON.parse(text)).toEqual(original);
  expect((await call({ section: 'observations', reference: foreign })).available).toBe(false);
  await expect(tool.execute!(tool.inputSchema.parse({ section: 'observations' }), { ...context, siteId: 'different' })).rejects.toThrow('scope');
});

it('returns a failed operation receipt with successful partial effects intact', async () => {
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const operation = await beginTaskDecision(f.db, task, {});
  await setTaskAction(f.db, task, operation, { name: 'save_findings', input: {} });
  const output = { saved: ['finding-7'], invalid: ['unknown-reference'], effects: 'partial' };
  await finishTaskOperation(f.db, task, operation, output, 'Unknown reference');
  const tool = taskMemoryTool({ DB: f.db } as RuntimeAgentEnv);
  const result = await tool.execute!(tool.inputSchema.parse({ section: 'operations', reference: operation.id }),
    { runId: task.active_run_id, workspaceId: 'w', siteId: 's', idempotencyKey: 'receipt-read' }) as {status:string;error:string;excerpt:string};
  expect(result.status).toBe('failed');
  expect(result.error).toBe('Unknown reference');
  expect(JSON.parse(result.excerpt)).toEqual(output);
});
