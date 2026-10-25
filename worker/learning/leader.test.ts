import { topicDeliveryStatements } from './delivery';
import { validateFindings } from './attribution';
import { learningTools } from './agent';
import { leaderLearningToolNames } from './leader';
import { currentExecution } from '../agent-runtime/runtime-executions';
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
import { addLeaderLearningTools, LEADER_LEARNING_TOOLS } from './leader';
import { submitLearning } from './agent';
import type { EvaluationAgreement } from '../../shared/learning';
import { bindDelegatedExperienceUses } from './delegation';
import { addEvidence, adoptExperience, commitRecords, createPractice, recordPreparationFailure, recordView, requireRecord, taskLearning, type LearningRequest } from './store';

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
    const args = { agent_ref: 'topic_decision', experience_uses: [], scope_ref: scopeRef, practice_ref: practice,
      goal: 'Choose a distinct reader need', reason: 'Test useful responses', context: 'Prior delivery showed practical examples were useful.' };
    const before = (await requireRecord(f.db, scope, practice)).data_json;
    const result = await call.call('delegate_task', args) as { task_ref: string };
    expect(await call.call('delegate_task', args)).toEqual(result);
    expect((await requireRecord(f.db, scope, practice)).data_json).toBe(before);
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
    const scopeRef = await saveSlot(f.env.DB, call.current, 'leader_scope', { locale: 'en' });
    const args = { agent_ref: 'topic_decision', experience_uses: [], scope_ref: scopeRef, practice_ref: practice, goal: 'Research need', reason: 'Pilot', context: '' };
    await bindDelegatedExperienceUses(f.env, call.current, call.operation, practice, [], call.registry.resolve(agentDefinition('growth_leader'), 'delegate_task').inputSchema.parse(args));
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
    const args = { agent_ref: 'topic_decision', experience_uses: [], scope_ref: scopeRef, goal: 'Standalone proposal', reason: 'No outcome experiment', context: '' };
    await expect(call.call('delegate_task', args)).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
    const result = await call.call('delegate_task', { ...args, practice_ref: null }) as { task_ref: string; learning_practice_ref: null };
    expect(result.learning_practice_ref).toBeNull();
    expect(await call.call('delegate_task', { ...args, practice_ref: null })).toEqual(result);
    const laterPractice = await f.prepare('practice:must-not-rebind');
    await expect(call.call('delegate_task', { ...args, practice_ref: laterPractice })).rejects.toThrow('identity conflict');
    expect(f.sqlite.prepare('select count(*) n from learning_delegations').get()).toEqual({ n: 0 });
    expect((await taskLearning(f.db, scope, result.task_ref)).formed).toBeNull();
    const old = leaderTools(f.env, step, { ...call.current, definition_version: 19 }, call.operation)
      .resolve(agentDefinition('growth_leader'), 'delegate_task');
    expect(old.version).toBe(5);
    expect(old.inputSchema.safeParse(args).success).toBe(true);
  });

  it('saves declared adoption with the real assignment and replays after dispatch interruption without rechecking newer history', async () => {
    const f = await fixture(), practice = await f.prepare('practice:adopting');
    const history = await createPractice(f.db, scope, 'history', 'topic_decision', 'Failure lesson');
    const unused = await createPractice(f.db, scope, 'unused', 'topic_decision', 'Unselected candidate');
    const read = await f.tools();
    const selected = await read.call('read_business_experience', { experience_id: history.id }) as { experience_ref: string };
    await read.call('read_business_experience', { experience_id: unused.id });
    await read.finish(selected);
    const call = await f.tools();
    const args = { agent_ref: 'topic_decision', scope_ref: await saveSlot(f.env.DB, call.current, 'leader_scope', { locale: 'en' }),
      practice_ref: practice, goal: 'Choose useful scenarios', reason: 'Apply the earlier caution', context: 'Prior failure is not proof of future success.',
      experience_uses: [{ experience_ref: selected.experience_ref, reason: 'Replace broad claims with concrete user scenarios', compatibility: 'Same audience; outcomes remain unknown' }] };
    // Lose dispatch after the atomic learning receipt, then retry the original decision.
    f.create.mockRejectedValueOnce(new Error('Dispatch response unavailable'));
    await expect(call.call('delegate_task', args)).rejects.toThrow('Dispatch response unavailable');
    expect(f.sqlite.prepare('select count(*) n from learning_uses').get()).toEqual({ n: 1 });
    const version = (await requireRecord(f.db, scope, practice)).version;
    await commitRecords(f.db, scope, 'later-history-revision', {}, [{ previous: history, data: recordView(history) }]);
    const result = await call.call('delegate_task', args) as { task_ref: string; registered_experience_uses: unknown[] };
    expect(result.registered_experience_uses).toEqual(args.experience_uses);
    expect(await call.call('delegate_task', args)).toEqual(result);
    expect((await requireRecord(f.db, scope, practice)).version).toBe(version);
    expect(f.sqlite.prepare('select experience_id,task_id,observed_version from learning_uses').all()).toEqual([
      { experience_id: history.id, task_id: f.task.id, observed_version: 0 },
    ]);
    expect(f.sqlite.prepare('select count(*) n from agent_tasks where parent_task_id=?').get(f.task.id)).toEqual({ n: 1 });
    const assignment = f.sqlite.prepare('select context_json from agent_task_assignments where task_id=?').get(result.task_ref) as { context_json: string };
    expect(JSON.parse(assignment.context_json).context).toContain(args.experience_uses[0].reason);
    expect(JSON.parse(assignment.context_json).context).toContain(args.experience_uses[0].compatibility);
    expect((await taskLearning(f.db, scope, result.task_ref)).formed?.id).toBe(practice);
    expect(recordView(await requireRecord(f.db, scope, history.id)).utility.score).toBeNull();
    await expect(call.call('delegate_task', { ...args, experience_uses: [] })).rejects.toThrow('identity conflict');
    await expect(call.call('delegate_task', { ...args, goal: 'Changed decision' })).rejects.toThrow('identity conflict');
  });

  it('allows explicit non-adoption, including a prepared practice with read candidates', async () => {
    const f = await fixture(), practice = await f.prepare('practice:none');
    const history = await createPractice(f.db, scope, 'history', 'topic_decision', 'Candidate');
    const read = await f.tools();
    await read.finish(await read.call('read_business_experience', { experience_id: history.id }));
    const call = await f.tools();
    const args = { agent_ref: 'topic_decision', scope_ref: await saveSlot(f.env.DB, call.current, 'leader_scope', { locale: 'en' }),
      practice_ref: practice, goal: 'Explore another audience', reason: 'Lesson does not apply', context: '' };
    await expect(call.call('delegate_task', args)).rejects.toThrow();
    const result = await call.call('delegate_task', { ...args, experience_uses: [] }) as { registered_experience_uses: unknown[] };
    expect(result.registered_experience_uses).toEqual([]);
    expect(f.sqlite.prepare('select count(*) n from learning_uses').get()).toEqual({ n: 0 });
    expect(recordView(await requireRecord(f.db, scope, history.id)).utility.score).toBeNull();
    const old = leaderTools(f.env, step, { ...call.current, definition_version: 23 }, call.operation).resolve(agentDefinition('growth_leader'), 'delegate_task');
    expect(old.version).toBe(6);
    expect(old.inputSchema.safeParse(args).success).toBe(true);
  });

  it.each(['unread', 'foreign-task', 'foreign-site', 'stale', 'self', 'duplicate', 'no-practice'])(
    'rejects %s experience use before any adoption or child effects', async problem => {
      const f = await fixture(), practice = await f.prepare('practice:validation');
      const history = await createPractice(f.db, scope, 'history', 'topic_decision', 'History');
      const call = await f.tools();
      const first = await saveSlot(f.env.DB, call.current, 'business_experience', { id: history.id, version: history.version });
      let bad = 'unread-candidate-id';
      if (problem === 'foreign-task') {
        const foreignRun = await createAgentRun(f.db, { id: 'foreign', ...scope, agentId: 'growth_leader', instanceId: 'foreign', trigger: 'manual', definitionVersion: 24, promptVersion: 'test' });
        const foreign = await attachTask(f.db, foreignRun, agentDefinition('growth_leader'));
        bad = await saveSlot(f.db, foreign, 'business_experience', { id: history.id, version: history.version });
      } else if (problem === 'foreign-site') {
        f.insert('sites', { id: 'other-site', workspace_id: scope.workspaceId, source_locale: 'en', translate_locales_json: '[]' });
        const foreign = await createPractice(f.db, { ...scope, siteId: 'other-site' }, 'other-history', 'topic_decision', 'Other site');
        bad = await saveSlot(f.env.DB, call.current, 'business_experience', { id: foreign.id, version: foreign.version });
      } else if (problem === 'stale') {
        const changed = await createPractice(f.db, scope, 'changed-history', 'topic_decision', 'Changed history');
        bad = await saveSlot(f.env.DB, call.current, 'business_experience', { id: changed.id, version: changed.version });
        await commitRecords(f.db, scope, 'change-history', {}, [{ previous: changed, data: recordView(changed) }]);
      } else if (problem === 'self') {
        const own = await requireRecord(f.db, scope, practice);
        bad = await saveSlot(f.env.DB, call.current, 'business_experience', { id: own.id, version: own.version });
      } else if (problem === 'duplicate' || problem === 'no-practice') bad = first;
      const use = { reason: 'Concrete guidance', compatibility: 'Same context' };
      const args = { agent_ref: 'topic_decision', scope_ref: await saveSlot(f.env.DB, call.current, 'leader_scope', { locale: 'en' }),
        practice_ref: problem === 'no-practice' ? null : practice, goal: 'Research', reason: 'Pilot', context: '',
        experience_uses: [{ ...use, experience_ref: first }, { ...use, experience_ref: bad }] };
      const version = (await requireRecord(f.db, scope, practice)).version;
      await expect(call.call('delegate_task', args)).rejects.toThrow();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.sqlite.prepare('select count(*) n from learning_uses').get()).toEqual({ n: 0 });
      expect(f.sqlite.prepare('select count(*) n from learning_delegations').get()).toEqual({ n: 0 });
      expect((await requireRecord(f.db, scope, practice)).version).toBe(version);
    },
  );

  it('rolls back the whole adoption set when a history version changes at commit, and reconciles a lost commit response', async () => {
    const f = await fixture(), practice = await f.prepare('practice:atomic');
    const first = await createPractice(f.db, scope, 'first-history', 'topic_decision', 'First');
    const second = await createPractice(f.db, scope, 'second-history', 'topic_decision', 'Second');
    const call = await f.tools();
    const uses = await Promise.all([first, second].map(async row => ({
      experience_ref: await saveSlot(f.env.DB, call.current, 'business_experience', { id: row.id, version: row.version }),
      reason: `Apply ${row.title}`, compatibility: 'Relevant conditions',
    })));
    const args = { agent_ref: 'topic_decision', scope_ref: await saveSlot(f.env.DB, call.current, 'leader_scope', { locale: 'en' }),
      practice_ref: practice, goal: 'Research', reason: 'Pilot', context: '', experience_uses: uses };
    const version = (await requireRecord(f.db, scope, practice)).version;
    const batch = f.db.batch;
    let raced = false;
    f.db.batch = (async statements => {
      if (!raced) {
        raced = true;
        await commitRecords({ ...f.db, batch } as D1Database, scope, 'concurrent-history', {}, [{ previous: second, data: recordView(second) }]);
      }
      return batch(statements);
    }) as typeof f.db.batch;
    await expect(call.call('delegate_task', args)).rejects.toThrow('changed before adoption committed');
    expect(f.sqlite.prepare('select count(*) n from learning_uses').get()).toEqual({ n: 0 });
    expect(f.sqlite.prepare('select count(*) n from learning_delegations').get()).toEqual({ n: 0 });
    expect((await requireRecord(f.db, scope, practice)).version).toBe(version);
    expect(f.create).not.toHaveBeenCalled();
    f.db.batch = batch;
    args.experience_uses[1].experience_ref = await saveSlot(f.env.DB, call.current, 'business_experience', { id: second.id, version: 1 });
    let lost = false;
    f.db.batch = (async statements => {
      const result = await batch(statements);
      if (!lost) { lost = true; throw new Error('Commit response lost'); }
      return result;
    }) as typeof f.db.batch;
    const result = await call.call('delegate_task', args);
    expect(await call.call('delegate_task', args)).toEqual(result);
    expect(f.sqlite.prepare('select count(*) n from learning_uses').get()).toEqual({ n: 2 });
    expect((await requireRecord(f.db, scope, practice)).version).toBe(version + 1);
  });

  it('completes declared delegation → formal delivery → compatible feedback → utility, deduplicating practice use and corrections', async () => {
    const f = await fixture(), practice = await f.prepare('practice:outcome');
    const history = await createPractice(f.db, scope, 'history', 'topic_decision', 'An earlier failure lesson');
    const unused = await createPractice(f.db, scope, 'unused', 'topic_decision', 'Another candidate');
    const agreement: EvaluationAgreement = { version: 1, objective: 'Reach 10 clicks', basis: ['Synthetic pre-action brief'],
      inputs: [{ name: 'clicks', unit: 'count', source: 'gsc' }], method: 'numeric', constants: { target: 10, one: 1 },
      steps: [{ name: 'ratio', op: 'divide', left: 'clicks', right: 'target' }, { name: 'score', op: 'min', left: 'ratio', right: 'one' }],
      output: 'score', rubric: '', score_meaning: 'Discovery target attainment, not conversion', unavailable_when: ['Incomplete observation'], comparison_key: 'synthetic-click-target' };
    for (const id of [practice, history.id]) {
      const previous = await requireRecord(f.db, scope, id), data = recordView(previous);
      data.experience.evaluation = agreement;
      data.experience.preparation = 'ready';
      await commitRecords(f.db, scope, `pre-action:${id}`, {}, [{ previous, data }]);
    }
    const read = await f.tools();
    const selected = await read.call('read_business_experience', { experience_id: history.id }) as { experience_ref: string };
    await read.finish(selected);
    for (const agent of ['topic_decision', 'deep_research']) {
      const call = await f.tools();
      const result = await call.call('delegate_task', { agent_ref: agent,
        scope_ref: await saveSlot(f.env.DB, call.current, 'leader_scope', { locale: 'en' }), practice_ref: practice,
        goal: 'Investigate concrete email scenarios', reason: 'Apply a prior caution', context: 'Synthetic practice',
        experience_uses: [{ experience_ref: selected.experience_ref, reason: 'Avoid broad unsupported claims; use concrete scenarios', compatibility: 'Same discovery objective, with unknown future results' }],
      }) as { task_ref: string };
      await call.finish(result);
      await stopTask(f.db, result.task_ref, 'completed', '', 'delivered', { summary: 'Delivered concrete scenarios; impact unknown', evidence: ['synthetic-formal-artifact'] });
    }
    expect(f.sqlite.prepare('select count(*) n from learning_uses where practice_id=?').get(practice)).toEqual({ n: 1 });
    expect(f.sqlite.prepare("select count(*) n from learning_evidence where record_id=? and kind='report'").get(practice)).toEqual({ n: 2 });
    expect(recordView(await requireRecord(f.db, scope, history.id)).utility.score).toBeNull();
    // Delayed measurements remain independent of a finished business parent.
    await stopTask(f.db, f.task.active_run_id, 'completed', '', 'business delivered');
    const definition = agentDefinition('learning_agent');
    const run = await createAgentRun(f.db, { id: 'feedback-learner', ...scope, agentId: definition.id, instanceId: 'feedback',
      definitionVersion: definition.definitionVersion, promptVersion: definition.promptVersion, trigger: 'manual' });
    const learner = await attachTask(f.db, run, definition);
    const feedback = async (key: string, clicks: number, compatible = true) => {
      await addEvidence(f.db, scope, practice, key, 'outcome', 'synthetic-gsc', { complete: true, values: { clicks: { value: clicks, unit: 'count' } } });
      f.sqlite.prepare("update learning_requests set run_id='' where run_id=?").run(run.id);
      f.sqlite.prepare("update learning_requests set run_id=?,status='running' where id=?").run(run.id, `evidence:${key}`);
      const current = await requireRecord(f.db, scope, practice), historical = await requireRecord(f.db, scope, history.id);
      const input: Parameters<typeof submitLearning>[3] = {
        observation_ref: await saveSlot(f.db, learner, 'learning_record', { id: practice, version: current.version }),
        title: current.title, goal: '', context: '', expectation: '', hypothesis: '', approach: '', adjustments: [], delivery: '',
        evaluation: null, observation: null, conclusion: '', limitations: [], findings: [], evidence_refs: [key], reward: null,
        compatible_uses: compatible ? [{ experience_id: history.id,
          observation_ref: await saveSlot(f.db, learner, 'learning_record', { id: history.id, version: historical.version }),
          reason: 'Same business claim and frozen scoring meaning; association is not causation' }] : [],
      };
      const result = await submitLearning(f.host, learner, `feedback:${key}`, input);
      expect(await submitLearning(f.host, learner, `feedback:${key}`, input)).toEqual(result);
    };
    await feedback('not-comparable', 10, false);
    expect(recordView(await requireRecord(f.db, scope, history.id)).utility.score).toBeNull();
    await feedback('observed', 10);
    expect(recordView(await requireRecord(f.db, scope, history.id)).utility).toMatchObject({ score: 1, feedback_count: 1 });
    await feedback('corrected', 2);
    expect(recordView(await requireRecord(f.db, scope, history.id)).utility).toMatchObject({ score: 0.2, feedback_count: 1 });
    expect(f.sqlite.prepare('select count(*) n from learning_feedback').get()).toEqual({ n: 1 });
    expect(recordView(await requireRecord(f.db, scope, unused.id)).utility.score).toBeNull();
    const own = recordView(await requireRecord(f.db, scope, practice));
    expect(own.utility.score).toBeNull();
    expect(own.experience.evaluation).toEqual(agreement);
    expect((await taskForRun(f.db, f.task.active_run_id))!.status).toBe('completed');
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
    await record.call('record_business_practice', { practice_ref: second, summary: 'The Leader changed the brief; implementation is still pending.', task_refs: [], evidence_refs: [] });
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
    const dispatched = await call.call('delegate_task', { agent_ref: 'topic_decision', experience_uses: [], scope_ref: scopeRef,
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

const rubricAgreement: EvaluationAgreement = {
  version: 1, objective: 'Assess the delivered brief against its declared evidence requirements', basis: ['Synthetic authorized brief'],
  method: 'rubric', inputs: [], constants: {}, steps: [], output: '', rubric: 'A supported, actionable brief passes; missing required verification remains unknown.',
  score_meaning: 'Artifact quality, not market performance', unavailable_when: ['Required independent review absent'], comparison_key: 'synthetic-brief-quality-v1',
  evidence_plan: { source: 'Formal deliverable and reviewer report', collector: 'Leader obtains the independent review; Learning Agent assesses it', ready_when: 'Both original receipts exist' },
};
async function outcomeFixture() {
  const f = await fixture(), practice = await f.prepare('practice:evaluation');
  const previous = await requireRecord(f.db, scope, practice), data = recordView(previous);
  data.experience.preparation = 'ready'; data.experience.evaluation = rubricAgreement;
  await commitRecords(f.db, scope, 'evaluation-plan', {}, [{ previous, data }]);
  const delegation = await f.tools();
  const delegated = await delegation.call('delegate_task', { agent_ref: 'topic_decision', practice_ref: practice, experience_uses: [],
    scope_ref: await saveSlot(f.env.DB, delegation.current, 'leader_scope', { locale: 'en' }), goal: 'Deliver a brief', reason: 'Authorized planning', context: 'Return a formal draft; no publication' }) as { task_ref: string };
  await delegation.finish(delegated);
  const execution = (await currentExecution(f.db, delegated.task_ref))!;
  await activateRuntimeExecution(f.db, authorityForExecution(execution), execution.workflow_id);
  const childEnv = executionEnvironment(f.host, authorityForExecution(execution));
  const child = await requireTask(childEnv.DB, delegated.task_ref);
  const subject = { type: 'topic_group', id: 'synthetic-group', version: 'submission:1' };
  f.insert('topic_decision_results', { id: subject.id, workspace_id: scope.workspaceId, site_id: scope.siteId, run_id: child.active_run_id,
    decision_type: 'topic_group', status: 'draft', strategy_version_id: null, submission_operation_id: 'submission:1' });
  const delivery = { ...scope, runId: child.active_run_id, operationId: 'submission:1', groupId: subject.id, subjects: [subject], snapshot: { title: 'A concrete brief', claims: ['Demand unknown'] } };
  await childEnv.DB.batch(topicDeliveryStatements(childEnv.DB, delivery));
  const evidence = 'delivery:submission:1';
  const read = await f.tools(), evaluation = await read.call('read_business_evaluation', { practice_ref: practice }) as { evaluation_ref: string; agreement: EvaluationAgreement; evidence: any[] };
  await read.finish(evaluation);
  return { ...f, practice, child, childEnv, subject, evidence, evaluation, delivery };
}

it('keeps evaluation tools and schemas pinned for legacy Leaders and learning tasks', async () => {
  expect(leaderLearningToolNames(24)).not.toContain('submit_business_outcome');
  expect(leaderLearningToolNames(25)).toContain('submit_business_outcome');
  const definition = agentDefinition('learning_agent');
  const old = learningTools({} as RuntimeAgentEnv, { definition_version: 5 } as AgentTask).resolve(definition, 'submit_learning_result');
  const next = learningTools({} as RuntimeAgentEnv, { definition_version: 6 } as AgentTask).resolve(definition, 'submit_learning_result');
  expect(old.version).toBe(5); expect(next.version).toBe(6);
  expect(JSON.stringify(old.inputSchema)).not.toContain('outcome_supported');
  expect(JSON.stringify(next.inputSchema)).toContain('outcome_supported');
});

it('captures a child delivery snapshot with exact versions, preserves replays and validates referenced findings', async () => {
  const f = await outcomeFixture();
  expect(f.evaluation.agreement).toEqual(rubricAgreement);
  expect(f.evaluation.evidence.find(e => e.id === f.evidence).attribution.subjects).toEqual([f.subject]);
  await f.childEnv.DB.batch(topicDeliveryStatements(f.childEnv.DB, f.delivery));
  expect(f.sqlite.prepare('select payload_json from learning_evidence where id=?').get(f.evidence)).toMatchObject({ payload_json: JSON.stringify({ receipt_id: 'submission:1', snapshot: f.delivery.snapshot }) });
  const finding = { kind: 'delivery' as const, scope: 'object' as const, subjects: [f.subject], text: 'Delivered the supported version', evidence_refs: [f.evidence] };
  await expect(validateFindings(f.db, f.practice, [finding])).resolves.toBeUndefined();
  await expect(validateFindings(f.db, f.practice, [{ ...finding, subjects: [{ ...f.subject, version: 'wrong-version' }] }])).rejects.toThrow('attribution mismatch');
  await f.db.batch(topicDeliveryStatements(f.db, { ...f.delivery, siteId: 'foreign-site', operationId: 'foreign-delivery' }));
  expect(f.sqlite.prepare("select count(*) n from learning_evidence where id='delivery:foreign-delivery'").get()).toEqual({ n: 0 });
  await stopTask(f.childEnv.DB, f.child.active_run_id, 'completed', 'Formal brief delivered', 'delivered', { id: f.subject.id });
  expect(f.sqlite.prepare("select count(*) n from learning_evidence where record_id=? and kind='delivery'").get(f.practice)).toEqual({ n: 1 });
});

it('preserves scoped evidence in Leader summaries and rejects foreign evidence or another coordinator', async () => {
  const f = await outcomeFixture();
  const call = await f.tools();
  const result = await call.call('record_business_practice', { practice_ref: f.practice, summary: 'Delivery reviewed with uncertainty', task_refs: [f.child.id], evidence_refs: [f.evidence] });
  await call.finish(result);
  const saved = f.sqlite.prepare("select attribution_json from learning_evidence where id=?").get(`leader-record:${call.operation.id}`)!;
  expect(JSON.parse(String(saved.attribution_json)).subjects).toEqual([f.subject]);
  const other = await f.prepare('practice:other');
  await addEvidence(f.db, scope, other, 'foreign-evidence', 'report', 'other-task', {});
  const bad = await f.tools();
  await expect(bad.call('submit_business_outcome', { evaluation_ref: f.evaluation.evaluation_ref, evidence_refs: ['foreign-evidence'], summary: 'Wrong', availability: 'complete', limitations: [], values: [] })).rejects.toThrow('outside this practice');
  const otherOwner = await createPractice(f.db, scope, 'other-leader', 'growth_leader', 'Other initiative', { id: 'practice:other-owner', material: {} });
  await expect(bad.call('read_business_evaluation', { practice_ref: otherOwner.id })).rejects.toThrow('another coordinator');
});

it('evaluates real tool-submitted evidence, preserves unknown review, and replaces one compatible utility contribution on correction', async () => {
  const f = await outcomeFixture();
  const history = await createPractice(f.db, scope, 'history-eval', 'growth_leader', 'Earlier lesson');
  const historical = recordView(history); historical.experience.evaluation = rubricAgreement;
  await commitRecords(f.db, scope, 'history-plan', {}, [{ previous: history, data: historical }]);
  const h = await requireRecord(f.db, scope, history.id);
  await adoptExperience(f.db, scope, f.task.id, f.task.agent_id, h.id, 'Use the prior caution', 'Same quality objective', 'adopt-eval', h.version, f.practice);
  const def = agentDefinition('learning_agent');
  const run = await createAgentRun(f.db, { id: 'outcome-learner', ...scope, agentId: def.id, instanceId: 'outcome-eval', definitionVersion: def.definitionVersion, promptVersion: def.promptVersion, trigger: 'manual' });
  const learner = await attachTask(f.db, run, def);
  const evaluate = async (supported: boolean, reward: number | null) => {
    const call = await f.tools();
    const args = { evaluation_ref: f.evaluation.evaluation_ref, evidence_refs: [f.evidence], summary: 'Synthetic source receipt for contract verification', availability: 'complete', limitations: [], values: [] };
    const result = await call.call('submit_business_outcome', args) as { evidence_ref: string };
    expect(await call.call('submit_business_outcome', args)).toEqual(result);
    await expect(call.call('submit_business_outcome', { ...args, summary: 'Changed replay' })).rejects.toThrow();
    await call.finish(result);
    f.sqlite.prepare("update learning_requests set run_id='' where run_id=?").run(run.id);
    f.sqlite.prepare("update learning_requests set run_id=?,status='running' where id=?").run(run.id, `evidence:${result.evidence_ref}`);
    const view = await learningTools(f.host, learner).resolve(def, 'read_learning_request').execute!({}, {} as never) as {
      outcome_evidence: { evidence_refs: string[]; evidence: Array<{ payload: unknown }> };
    };
    expect(view.outcome_evidence.evidence_refs).toEqual([f.evidence]);
    expect(view.outcome_evidence.evidence[0].payload).toEqual({ receipt_id: 'submission:1', snapshot: f.delivery.snapshot });
    const current = await requireRecord(f.db, scope, f.practice), old = await requireRecord(f.db, scope, history.id);
    const input: Parameters<typeof submitLearning>[3] = {
      observation_ref: await saveSlot(f.db, learner, 'learning_record', { id: current.id, version: current.version }),
      title: current.title, goal: '', context: '', expectation: '', hypothesis: '', approach: '', adjustments: [], delivery: '', evaluation: null, observation: null,
      conclusion: supported ? 'Synthetic review supports quality' : 'Independent review absent; outcome unknown', limitations: supported ? [] : ['Independent review absent'],
      evidence_refs: [result.evidence_ref, f.evidence], findings: [], reward, outcome_supported: supported,
      compatible_uses: [{ experience_id: old.id, observation_ref: await saveSlot(f.db, learner, 'learning_record', { id: old.id, version: old.version }), reason: 'Same frozen business meaning; not causal proof' }],
    };
    await submitLearning(f.host, learner, `assess:${result.evidence_ref}`, input);
    expect(recordView(await requireRecord(f.db, scope, f.practice)).experience.evaluation).toEqual(rubricAgreement);
  };
  // Completeness asserted by the Leader cannot establish an independent review.
  await evaluate(false, 1);
  expect(recordView(await requireRecord(f.db, scope, history.id)).utility).toMatchObject({ score: null, feedback_count: 0 });
  await evaluate(true, 1);
  expect(recordView(await requireRecord(f.db, scope, history.id)).utility).toMatchObject({ score: 1, feedback_count: 1 });
  await evaluate(true, 0.25);
  expect(recordView(await requireRecord(f.db, scope, history.id)).utility).toMatchObject({ score: 0.25, feedback_count: 1 });
  await evaluate(false, null);
  expect(recordView(await requireRecord(f.db, scope, history.id)).utility).toMatchObject({ score: null, feedback_count: 0 });
  expect(f.sqlite.prepare('select count(*) n from learning_feedback where practice_id=?').get(f.practice)).toEqual({ n: 1 });
});

it('rejects invented measurement slots and preserves automatic observation ownership and frozen agreement references', async () => {
  const f = await outcomeFixture();
  const args = { evaluation_ref: f.evaluation.evaluation_ref, evidence_refs: [f.evidence], summary: 'Synthetic observation', availability: 'complete', limitations: [], values: [] };
  const invalid = await f.tools();
  await expect(invalid.call('submit_business_outcome', { ...args, values: [{ name: 'invented_conversions', value: 20, unit: 'count' }] })).rejects.toThrow('agreed input and unit');
  let previous = await requireRecord(f.db, scope, f.practice), data = recordView(previous);
  data.experience.observation = { source: 'gsc', start: 'publication', days: 28, signals: ['clicks'], rationale: 'Synthetic agreed observation' };
  await commitRecords(f.db, scope, 'synthetic-observation-plan', {}, [{ previous, data }]);
  const automatic = await f.tools();
  await expect(automatic.call('submit_business_outcome', args)).rejects.toThrow('automatic GSC observation window');
  previous = await requireRecord(f.db, scope, f.practice); data = recordView(previous);
  data.experience.evaluation = { ...rubricAgreement, version: 2 };
  await commitRecords(f.db, scope, 'synthetic-replaced-agreement', {}, [{ previous, data }]);
  const stale = await f.tools();
  await expect(stale.call('submit_business_outcome', args)).rejects.toThrow('frozen, observed pre-action agreement');
  expect(f.sqlite.prepare("select count(*) n from learning_evidence where kind='outcome'").get()).toEqual({ n: 0 });
});
