import { expect, it } from 'vitest';
import { taskTestDb } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, beginTaskDecision, requireTask } from './task-store';
import { initializeConversation } from './conversation-store';
import { currentAudit, executionAuditTool, prepareAudit } from './execution-audit';

async function fixture() {
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  await initializeConversation(f.db, task, 'Mission', { goal: 'Save an actual artifact' });
  await f.db.prepare('update agent_conversations set normal_decisions=30').run();
  await prepareAudit(f.db, task);
  const operation = await beginTaskDecision(f.db, task, {});
  const tool = executionAuditTool(f.db, task, operation, ['submit_business']);
  const decision = { decision: 'continue', reason: 'Useful progress', progress: 'Evidence saved', remaining_work: 'Draft deliverable', next_stage_method: 'Use the evidence to draft', outcome: 'partial', artifact_refs: [], unresolved_issues: ['Draft remains'] };
  const context = { runId: task.active_run_id, workspaceId: task.workspace_id, siteId: task.site_id, idempotencyKey: operation.id };
  return { ...f, task, operation, tool, decision, context };
}

it('replays an audit receipt without allocating another window after a lost tool result', async () => {
  const f = await fixture();
  const result = await f.tool.execute!(f.decision, f.context);
  expect(await f.tool.execute!(f.decision, f.context)).toEqual(result);
  expect(await currentAudit(f.db, f.task.id)).toMatchObject({ number: 2, start_decision: 30, end_decision: 60, status: 'normal' });
  expect((await requireTask(f.db, f.task.active_run_id)).next_turn).toBe(2);
  expect(await f.db.prepare('select count(*) as n from agent_runtime_audits').first('n')).toBe(2);
});

it('rejects fabricated completion but preserves an honest partial finish with its unresolved work', async () => {
  const f = await fixture();
  await expect(f.tool.execute!({ ...f.decision, decision: 'finish', outcome: 'completed' }, f.context)).rejects.toThrow('business submission');
  const partial = { ...f.decision, decision: 'finish', outcome: 'partial', artifact_refs: ['evidence:1'] };
  await f.tool.execute!(partial, f.context);
  expect(await f.db.prepare('select status,outcome,output_json from agent_tasks where id=?').bind(f.task.id).first()).toEqual({ status: 'completed', outcome: 'partial', output_json: JSON.stringify(partial) });
  expect(await f.tool.execute!(partial, f.context)).toEqual(partial);
});
