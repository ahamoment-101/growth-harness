import { describe, expect, it, vi } from 'vitest';
vi.mock('agents', () => ({ getAgentByName: vi.fn() }));
// @ts-ignore Node-only migration fixture.
import { readFileSync, readdirSync } from 'node:fs';
// @ts-ignore Node-only migration fixture.
import { DatabaseSync } from 'node:sqlite';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { schemaTestDb } from '../lib/schema-test-db';
import { agentDefinition } from '../agent-runtime/definitions';
import { createAgentRun } from '../agent-runtime/store';
import { attachTask, beginTaskDecision, finishTaskOperation, requireTask, taskForRun, stopTask, type AgentTask } from '../agent-runtime/task-store';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution } from '../agent-runtime/runtime-executions';
import { executionEnvironment } from '../agent-runtime/execution-context';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from '../agent-runtime/env';
import { ToolRegistry } from '../agent-runtime/tools';
import { saveSlot } from '../agent-runtime/parameter-slots';
import { leaderTools } from '../growth-leader/tools';
import { startRuntimeRun } from '../agent-runtime/run-service';
import { addBusinessLearningTools, BUSINESS_LEARNING_TOOLS, LEARNING_SINCE, supportsLearning } from './business';
import { addLeaderLearningTools, LEADER_LEARNING_TOOLS, bindLearningDelegation } from './leader';
import { adoptExperience, commitRecords, createPractice, recordPreparationFailure, recordView, requireRecord, taskLearning, type LearningRequest } from './store';

const scope = { workspaceId: 'primary-workspace', siteId: 's' };
const step = { do: async (_key: string, config: unknown, fn?: () => Promise<unknown>) => (fn || config as () => Promise<unknown>)(), sleep: async () => {} } as unknown as RuntimeWorkflowStep;
async function fixture() {
  const f = schemaTestDb();
  f.db.batch = (async (statements: D1PreparedStatement[]) => {
    f.sqlite.exec('begin');
    try { const out = []; for (const s of statements) out.push(await s.run()); f.sqlite.exec('commit'); return out; }
    catch (e) { f.sqlite.exec('rollback'); throw e; }
  }) as typeof f.db.batch;
  f.insert('sites', { id: 's', workspace_id: scope.workspaceId, source_locale: 'en', translate_locales_json: '[]' });
  const definition = agentDefinition('growth_leader');
  const run = await createAgentRun(f.db, { id: 'leader', ...scope, agentId: definition.id, instanceId: 'leader',
    definitionVersion: definition.definitionVersion, promptVersion: definition.promptVersion, trigger: 'manual' });
  await attachTask(f.db, run, definition);
  const execution = await createRuntimeExecution(f.db, run.id);
  await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  const create = vi.fn(async (options: { id: string }) => ({ id: options.id }));
  const host = { DB: f.db, AGENT_WORKFLOW: { create } } as unknown as RuntimeAgentEnv;
  const env = executionEnvironment(host, authorityForExecution(execution));
  const task = await requireTask(env.DB, run.id);
  const definitionWithLearning = { ...definition, tools: [...definition.tools, ...BUSINESS_LEARNING_TOOLS, ...LEADER_LEARNING_TOOLS] };
  const tools = async (testStep = step) => {
    const current = await requireTask(env.DB, run.id);
    const operation = await beginTaskDecision(env.DB, current, {});
    const registry = leaderTools(env, testStep, current, operation);
    addBusinessLearningTools(registry, env, current, operation);
    addLeaderLearningTools(registry, env, testStep, current, operation);
    const call = (name: string, input: unknown) => registry.execute(definitionWithLearning, name, input, {
      runId: run.id, ...scope, idempotencyKey: operation.id,
    });
    return { operation, current, registry, call, finish: (output: unknown) => finishTaskOperation(env.DB, current, operation, output) };
  };
  const prepare = async (id: string) => {
    const row = await createPractice(env.DB, scope, task.id, task.agent_id, id, { id, material: { goal: id } });
    // A known unavailable evaluation is a valid preparation result; no invented outcome.
    const req = await f.db.prepare('select * from learning_requests where record_id=?').bind(row.id).first<LearningRequest>();
    await recordPreparationFailure(f.db, scope, req!, `unavailable:${id}`, 'Synthetic source unavailable', true);
    return row.id;
  };
  return { ...f, host, env, task, execution, create, tools, prepare };
}

describe('Leader-only learning integration', () => {
  it('reads complete semantic-search evidence through the fenced tool instead of log truncation', async () => {
    const f = await fixture(), id = await f.prepare('long-evidence');
    const previous = await requireRecord(f.env.DB, scope, id), data = recordView(previous);
    const insight = 'Formal business evidence with attribution. '.repeat(200) + 'Final limitation must remain readable.';
    data.experience.insight = insight;
    await commitRecords(f.env.DB, scope, 'long-evidence-revision', {}, [{ previous, data }]);
    const call = await f.tools();
    const result = await call.call('read_business_experience', { experience_id: id }) as { record: { experience: { insight: string } }; experience_ref: string };
    expect(result.record.experience.insight).toBe(insight);
    expect(result.experience_ref).toMatch(/^ref-/);
    await call.finish(result);
  });
  it('removes learning from every new specialist while preserving exact legacy contracts', () => {
    for (const [agentId, legacyVersion] of Object.entries(LEARNING_SINCE)) {
      if (agentId === 'growth_leader') continue;
      const definition = agentDefinition(agentId as Parameters<typeof agentDefinition>[0]);
      const task = { agent_id: agentId, definition_version: definition.definitionVersion } as AgentTask;
      const registry = new ToolRegistry();
      addBusinessLearningTools(registry, {} as RuntimeAgentEnv, task);
      expect(registry.names()).toEqual([]);
      expect(supportsLearning(task)).toBe(false);
      expect(supportsLearning({ ...task, definition_version: legacyVersion })).toBe(true);
    }
  });

  it('keeps two practices distinct under the same persistent Leader and replays preparation without duplicating it', async () => {
    const f = await fixture();
    let sleeps = 0;
    const unavailable = { ...step, sleep: async () => {
      const req = await f.db.prepare("select * from learning_requests where phase='prepare' and status='pending'").first<LearningRequest>();
      await recordPreparationFailure(f.db, scope, req!, `availability:${++sleeps}`, 'Synthetic temporary failure');
    } } as unknown as RuntimeWorkflowStep;
    const first = await f.tools(unavailable);
    const result = await first.call('prepare_business_practice', { goal: 'First initiative', context: 'Known business facts' }) as { practice_ref: string };
    expect(sleeps).toBe(3);
    expect(await first.call('prepare_business_practice', { goal: 'First initiative', context: 'Known business facts' })).toEqual(result);
    expect(sleeps).toBe(3);
    await first.finish(result);
    const second = await f.tools(unavailable);
    const next = await second.call('prepare_business_practice', { goal: 'Second initiative', context: '' }) as { practice_ref: string };
    expect(next.practice_ref).not.toBe(result.practice_ref);
    expect(sleeps).toBe(6);
    expect(f.sqlite.prepare('select count(*) n from learning_records where origin_task_id=?').get(f.task.id)).toEqual({ n: 2 });
    expect(f.sqlite.prepare('select count(*) n from learning_tasks where task_id=?').get(f.task.id)).toEqual({ n: 0 });
    expect(recordView(await requireRecord(f.db, scope, result.practice_ref)).experience.evaluation).toBeNull();
  });

  it('attributes real child dispatch before activation and replays one child without exposing learning to it', async () => {
    const f = await fixture();
    const practice = await f.prepare('practice:first');
    const call = await f.tools();
    const scopeRef = await saveSlot(f.env.DB, call.current, 'leader_scope', { locale: 'en' });
    const args = { agent_ref: 'topic_decision', scope_ref: scopeRef, practice_ref: practice,
      goal: 'Choose a distinct reader need', reason: 'Test useful responses', context: 'Prior delivery showed practical examples were useful.' };
    const result = await call.call('delegate_task', args) as { task_ref: string };
    expect(await call.call('delegate_task', args)).toEqual(result);
    const child = (await taskForRun(f.db, result.task_ref))!;
    expect(child.parent_task_id).toBe(f.task.id);
    expect(supportsLearning(child)).toBe(false);
    expect((await taskLearning(f.db, scope, child.id)).formed?.id).toBe(practice);
    expect(new Set(f.create.mock.calls.map(call => call[0].id)).size).toBe(1);
    const assignment = await f.db.prepare('select context_json from agent_task_assignments where task_id=?').bind(child.id).first<{ context_json: string }>();
    expect(JSON.parse(assignment!.context_json)).toEqual({ goal: args.goal, reason: args.reason, context: args.context });
    await stopTask(f.db, child.active_run_id, 'completed', '', 'delivered', { summary: 'Delivered concrete examples', evidence: ['formal-artifact'] });
    expect(f.sqlite.prepare("select count(*) n from learning_evidence where record_id=? and kind='report'").get(practice)).toEqual({ n: 1 });
    expect(f.sqlite.prepare("select count(*) n from learning_requests where record_id=? and phase='record'").get(practice)).toEqual({ n: 1 });
  });

  it('preserves attribution on an interrupted dispatch and rejects a stale parent before effects', async () => {
    const f = await fixture();
    const practice = await f.prepare('practice:first');
    const call = await f.tools();
    await bindLearningDelegation(f.env, call.current, call.operation, practice);
    const scopeRef = await saveSlot(f.env.DB, call.current, 'leader_scope', { locale: 'en' });
    const args = { agent_ref: 'topic_decision', scope_ref: scopeRef, practice_ref: practice, goal: 'Research need', reason: 'Pilot', context: '' };
    const result = await call.call('delegate_task', args) as { task_ref: string };
    expect((await taskLearning(f.db, scope, result.task_ref)).formed?.id).toBe(practice);
    await call.finish(result);
    const next = await f.tools();
    await createRuntimeExecution(f.db, f.task.active_run_id, f.execution, 'handoff');
    await expect(next.call('delegate_task', args)).rejects.toThrow('stale');
    expect(f.sqlite.prepare('select count(*) n from learning_delegations').get()).toEqual({ n: 1 });
  });

  it('requires an explicit practice choice, permits null, and leaves old delegation schemas pinned', async () => {
    const f = await fixture();
    const call = await f.tools();
    const scopeRef = await saveSlot(f.env.DB, call.current, 'leader_scope', { locale: 'en' });
    const args = { agent_ref: 'topic_decision', scope_ref: scopeRef, goal: 'Standalone proposal', reason: 'No outcome experiment', context: '' };
    await expect(call.call('delegate_task', args)).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
    const result = await call.call('delegate_task', { ...args, practice_ref: null }) as { task_ref: string; learning_practice_ref: null };
    expect(result.learning_practice_ref).toBeNull();
    expect((await taskLearning(f.db, scope, result.task_ref)).formed).toBeNull();
    const old = leaderTools(f.env, step, { ...call.current, definition_version: 19 }, call.operation)
      .resolve(agentDefinition('growth_leader'), 'delegate_task');
    expect(old.version).toBe(5);
    expect(old.inputSchema.safeParse(args).success).toBe(true);
  });

  it('records adoption as the Leader, separates its practices, and refuses another coordinator', async () => {
    const f = await fixture();
    const first = await f.prepare('practice:first');
    const second = await f.prepare('practice:second');
    const history = await createPractice(f.db, scope, 'historic-task', 'topic_decision', 'Historic lesson');
    const call = await f.tools();
    const read = await call.call('read_business_experience', { experience_id: history.id }) as { experience_ref: string };
    const args = { practice_ref: second, experience_ref: read.experience_ref, reason: 'Use concrete examples in the delegated brief', compatibility: 'Same reader need and conditions' };
    await call.call('adopt_business_experience', args);
    await call.call('adopt_business_experience', args);
    expect(f.sqlite.prepare('select practice_id,task_id,agent_id from learning_uses').all()).toEqual([{ practice_id: second, task_id: f.task.id, agent_id: 'growth_leader' }]);
    expect(f.sqlite.prepare('select count(*) n from learning_uses where practice_id=?').get(first)).toEqual({ n: 0 });
    await expect(adoptExperience(f.db, scope, 'other-leader', 'growth_leader', history.id, 'Use', 'Same', 'wrong', history.version, second)).rejects.toThrow('another coordinator');
    expect((await requireRecord(f.db, scope, history.id)).version).toBe(0);
    await call.finish({});
    const record = await f.tools();
    await record.call('record_business_practice', { practice_ref: second, summary: 'The Leader changed the brief; implementation is still pending.', task_refs: [] });
    expect(f.sqlite.prepare("select count(*) n from learning_evidence where record_id=? and source_ref='leader'").get(second)).toEqual({ n: 1 });
  });

  it.each(['approve', 'revise'] as const)('preserves one practice through topic %s and passes ordinary business guidance', async decision => {
    const f = await fixture();
    const practice = await f.prepare('practice:first');
    const history = await createPractice(f.db, scope, 'history', 'topic_decision', 'Earlier risk-framing lesson');
    await adoptExperience(f.env.DB, scope, f.task.id, f.task.agent_id, history.id,
      'Use practical risk framing without unsupported legal claims', 'Same reader conditions', 'seed-adoption', 0, practice);
    const call = await f.tools();
    const scopeRef = await saveSlot(f.env.DB, call.current, 'leader_scope', { locale: 'en' });
    const dispatched = await call.call('delegate_task', { agent_ref: 'topic_decision', scope_ref: scopeRef,
      practice_ref: practice, goal: 'Choose a reader need', reason: 'Pilot', context: 'Use practical risk framing.' }) as { task_ref: string };
    await call.finish(dispatched);
    await stopTask(f.db, dispatched.task_ref, 'completed', '', 'submitted', { summary: 'One proposal' });
    f.sqlite.prepare("update agent_runs set status='succeeded' where id=?").run(dispatched.task_ref);
    f.insert('topic_decision_results', { id: 'group', ...{ workspace_id: scope.workspaceId, site_id: scope.siteId },
      run_id: dispatched.task_ref, submission_operation_id: 'topic-submit', decision_type: 'topic_group', status: 'draft',
      scope_locale: 'en', group_goal: 'Useful email examples', rationale: 'Reader need', updated_at: '2026-10-23T00:00:00Z' });
    f.insert('topic_decision_items', { id: 'item', result_id: 'group', title_direction: 'Reply calmly', primary_keyword: 'reply email',
      locale: 'en', rationale: 'Concrete help', sort_order: 0 });
    const review = await f.tools();
    const outcome = await review.call('review_topic_group', { group_ref: 'group', observed_updated_at: '2026-10-23T00:00:00Z',
      decision, reason: 'Preserve useful examples with cautious framing' }) as { content_task_ref?: string; revision_task_ref?: string };
    const nextId = outcome.content_task_ref || outcome.revision_task_ref!;
    expect((await taskLearning(f.db, scope, nextId)).formed?.id).toBe(practice);
    const assignment = await f.db.prepare('select context_json from agent_task_assignments where task_id=?').bind(nextId).first<{ context_json: string }>();
    expect(JSON.parse(assignment!.context_json).context.business_guidance).toEqual(['Use practical risk framing without unsupported legal claims']);
    expect(supportsLearning((await taskForRun(f.db, nextId))!)).toBe(false);
    if (decision === 'approve') {
      const contentExecution = await f.db.prepare('select * from agent_runtime_executions where task_id=?').bind(nextId).first<Parameters<typeof authorityForExecution>[0]>();
      await activateRuntimeExecution(f.db, authorityForExecution(contentExecution!), contentExecution!.workflow_id);
      const contentEnv = executionEnvironment(f.host, authorityForExecution(contentExecution!));
      const author = await startRuntimeRun(contentEnv, { runId: 'author', ...scope, agentId: 'article_production',
        trigger: 'sub_agent', parentRunId: nextId, summary: {} });
      expect((await taskLearning(f.db, scope, author.id)).formed?.id).toBe(practice);
      expect(supportsLearning((await taskForRun(f.db, author.id))!)).toBe(false);
      await stopTask(f.db, f.task.active_run_id, 'completed', '', 'finished');
      const job = f.sqlite.prepare("select id from jobs where decision_group_id='group'").get() as { id: string };
      f.sqlite.prepare("update jobs set status='published',current_artifact_id='real-version',published_at='2026-10-23T00:00:00Z' where id=?").run(job.id);
      expect(f.sqlite.prepare("select record_id from learning_evidence where kind='publication'").get()).toEqual({ record_id: practice });
      expect((await taskForRun(f.db, f.task.active_run_id))!.status).toBe('completed');
    }
  });

  it('migrates populated learning history transactionally without losing feedback or receipts', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('pragma foreign_keys=on');
    const dir = new URL('../../migrations/', import.meta.url);
    const files = readdirSync(dir.pathname).filter((name: string) => name.endsWith('.sql')).sort();
    for (const name of files.filter((name: string) => name < '0083')) db.exec(readFileSync(new URL(name, dir).pathname, 'utf8'));
    db.exec(`insert into learning_records values('practice:old','primary-workspace','s','old-task',0,'Old','observing','{}','a','a');
      insert into learning_tasks values('old-task','practice:old','topic_decision');
      insert into learning_evidence values('e','practice:old','outcome','source','{}','a');
      insert into learning_requests(id,record_id,phase,payload_json,available_at,created_at,updated_at) values('q','practice:old','feedback','{}','a','a','a');`);
    db.exec('begin');
    db.exec(readFileSync(new URL('0083_leader_learning.sql', dir).pathname, 'utf8'));
    db.exec('commit');
    expect(db.prepare('pragma foreign_key_check').all()).toEqual([]);
    expect(db.prepare('select id from learning_evidence').all()).toEqual([{ id: 'e' }]);
    expect(db.prepare('select id from learning_requests').all()).toEqual([{ id: 'q' }]);
    expect(db.prepare('select record_id from learning_tasks').all()).toEqual([{ record_id: 'practice:old' }]);
    db.close();
  });
});
