import { describe, it, expect } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import {
  createPractice,
  requireRecord,
  commitRecords,
  recordView,
  addEvidence,
  adoptExperience,
  taskLearning,
  learningPage,
  recordDetail,
} from './store';
import {
  evaluateNumeric,
  calculateObservedReward,
  validateAgreement,
  GSC_SIGNALS,
  utilityFromFeedback,
} from './calculation';
import type { EvaluationAgreement, LearningData } from '../../shared/learning';
import { saveSlot } from '../agent-runtime/parameter-slots';
import { taskForRun } from '../agent-runtime/task-store';
import { attachPractice, supportsLearning } from './business';
import { learningTools, preparationFailure, submitLearning } from './agent';
import { agentDefinition } from '../agent-runtime/definitions';
import type { RuntimeAgentEnv } from '../agent-runtime/env';

const scope = { workspaceId: 'w', siteId: 's' };
const agreement: EvaluationAgreement = {
  version: 1,
  objective: 'Reach 10 clicks',
  basis: ['User brief'],
  inputs: [{ name: 'clicks', unit: 'count', source: 'gsc' }],
  method: 'numeric',
  constants: { target: 10, one: 1 },
  steps: [
    { name: 'ratio', op: 'divide', left: 'clicks', right: 'target' },
    { name: 'score', op: 'min', left: 'ratio', right: 'one' },
  ],
  output: 'score',
  rubric: '',
  score_meaning: 'Goal attainment',
  unavailable_when: ['No complete window'],
  comparison_key: 'click-target-v1',
};
function fixture() {
  const f = schemaTestDb();
  // Unlike the small legacy shim, these tests exercise transaction rollback.
  f.db.batch = (async (statements: D1PreparedStatement[]) => {
    f.sqlite.exec('begin');
    try {
      const result = [];
      for (const s of statements) result.push(await s.run());
      f.sqlite.exec('commit');
      return result;
    } catch (e) {
      f.sqlite.exec('rollback');
      throw e;
    }
  }) as typeof f.db.batch;
  f.insert('workspaces', { id: 'w', name: 'Local' });
  f.insert('sites', { id: 's', workspace_id: 'w', name: 'Local site' });
  return f;
}
function task(
  f: ReturnType<typeof fixture>,
  id: string,
  agent = 'topic_decision',
) {
  f.insert('agent_runs', {
    id,
    workspace_id: 'w',
    site_id: 's',
    agent_id: agent,
    agent_instance_id: id,
    status: 'running',
    root_run_id: id,
  });
  f.insert('agent_tasks', {
    id,
    active_run_id: id,
    workspace_id: 'w',
    site_id: 's',
    agent_id: agent,
    agent_instance_id: id,
    status: 'running',
    root_task_id: id,
    definition_version: 1,
  });
  f.insert('agent_task_runs', { run_id: id, task_id: id, epoch: 0 });
}
async function ready(f: ReturnType<typeof fixture>, id: string) {
  task(f, id);
  const r = await createPractice(
    f.db,
    scope,
    id,
    'topic_decision',
    'Reach 10 clicks',
  );
  const data: LearningData = JSON.parse(r.data_json);
  data.experience.evaluation = agreement;
  data.experience.hypothesis = 'Specific comparisons help informed users';
  data.experience.preparation = 'ready';
  await commitRecords(f.db, scope, `ready:${id}`, { id }, [
    { previous: r, data, status: 'observing' },
  ]);
  f.sqlite
    .prepare(
      "update learning_requests set status='completed' where record_id=?",
    )
    .run(r.id);
  return r.id;
}
describe('business learning integrity', () => {
  it('v3 replaces unsupported prior interpretations with cited findings and replays the original submission once', async () => {
    const f = fixture(), id = await ready(f, 'topic');
    const old = await requireRecord(f.db, scope, id), before: LearningData = JSON.parse(old.data_json);
    before.experience.insight = 'Incorrect old conflict between two different objects';
    await commitRecords(f.db, scope, 'old-interpretation', {}, [{ previous: old, data: before }]);
    await addEvidence(f.db, scope, id, 'formal', 'feedback', 'topic', { result: 'Two different objects' });
    task(f, 'learner-v3', 'learning_agent');
    f.sqlite.prepare("update learning_requests set run_id='learner-v3',status='running' where id='evidence:formal'").run();
    const t = { ...(await taskForRun(f.db, 'learner-v3'))!, definition_version: 3 };
    const env = { DB: f.db } as RuntimeAgentEnv;
    const current = await requireRecord(f.db, scope, id);
    const args: Parameters<typeof submitLearning>[3] = {
      observation_ref: await saveSlot(f.db, t, 'learning_record', { id, version: current.version }),
      title: 'unused', goal: 'unused', context: '', expectation: '', hypothesis: '', approach: '',
      adjustments: [], delivery: 'Unchecked claim must not be saved', evaluation: null, observation: null,
      conclusion: 'Incorrect old conflict', limitations: [], evidence_refs: ['formal'], reward: null, compatible_uses: [],
      findings: [{ scope: 'practice', subjects: [], kind: 'conclusion', text: 'The prior conflict interpretation is withdrawn; the receipts concern different objects.', evidence_refs: ['formal'] }],
    };
    const first = await submitLearning(env, t, 'submit-v3', args);
    expect(await submitLearning(env, t, 'submit-v3', args)).toEqual(first);
    const saved = recordView(await requireRecord(f.db, scope, id));
    expect(saved.version).toBe(current.version + 1);
    expect(saved.experience.insight).toContain('withdrawn');
    expect(saved.experience.insight).not.toContain('Incorrect old conflict');
    expect(saved.experience.delivery).toBe('');
    expect(saved.experience.findings).toEqual(args.findings);
    expect(saved.experience.evaluation).toEqual(before.experience.evaluation);
    expect(saved.utility.score).toBeNull();
    const legacy = { ...t, definition_version: 2 };
    const legacyTool = learningTools(env, legacy).resolve(agentDefinition('learning_agent'), 'submit_learning_result');
    expect(legacyTool.inputSchema.safeParse({ ...args, findings: undefined }).success).toBe(true);
    const currentTool = learningTools(env, t).resolve(agentDefinition('learning_agent'), 'submit_learning_result');
    expect(currentTool.inputSchema.safeParse({ ...args, findings: undefined }).success).toBe(false);
  });
  it('reports a frozen arithmetic gap as unknown and keeps the agreement unchanged', () => {
    const frozen = { ...agreement, constants: { target: 0, one: 1 } };
    expect(
      calculateObservedReward(frozen, { clicks: { value: 0, unit: 'count' } }),
    ).toEqual({ reward: null, reason: 'Cannot divide by zero' });
    expect(frozen.constants.target).toBe(0);
  });
  it('gives repairable scoped reference feedback without guessing a task id', async () => {
    const f = fixture();
    const id = await ready(f, 'topic');
    await expect(requireRecord(f.db, scope, 'topic')).rejects.toMatchObject({
      details: {
        kind: 'invalid_request',
        effects: 'none',
        issues: [
          {
            path: ['experience_id'],
            message: 'Unknown scoped experience: topic',
          },
        ],
      },
    });
    expect((await requireRecord(f.db, scope, id)).id).toBe('practice:topic');
  });
  it('calculates only supported arithmetic and keeps unknown distinct from zero', () => {
    expect(() => validateAgreement(agreement, GSC_SIGNALS)).not.toThrow();
    expect(() =>
      validateAgreement(
        {
          ...agreement,
          inputs: [
            ...agreement.inputs,
            { name: 'target', unit: 'count', source: 'gsc' },
          ],
        },
        GSC_SIGNALS,
      ),
    ).toThrow('Duplicate');
    expect(() =>
      validateAgreement({ ...agreement, output: 'ratio' }, GSC_SIGNALS),
    ).toThrow('0–1');
    expect(
      evaluateNumeric(agreement, { clicks: { value: 5, unit: 'count' } }),
    ).toBe(0.5);
    expect(() =>
      evaluateNumeric(agreement, { clicks: { value: 5, unit: 'ratio' } }),
    ).toThrow('incompatible');
    expect(() =>
      evaluateNumeric(
        { ...agreement, constants: { target: 0, one: 1 } },
        { clicks: { value: 1, unit: 'count' } },
      ),
    ).toThrow('zero');
    expect(utilityFromFeedback([]).score).toBeNull();
    expect(utilityFromFeedback([{ reward: 0 }]).score).toBe(0);
    expect(utilityFromFeedback([{ reward: 1 }, { reward: 0 }]).score).toBe(0.8);
  });
  it('replays commits, rejects changed input and rolls back stale revisions', async () => {
    const f = fixture();
    const id = await ready(f, 'a'),
      prior = await requireRecord(f.db, scope, id),
      data: LearningData = JSON.parse(prior.data_json);
    const result = await commitRecords(f.db, scope, 'op', { x: 1 }, [
      { previous: prior, data },
    ]);
    expect(
      await commitRecords(f.db, scope, 'op', { x: 1 }, [
        { previous: prior, data },
      ]),
    ).toEqual(result);
    await expect(
      commitRecords(f.db, scope, 'op', { x: 2 }, [{ previous: prior, data }]),
    ).rejects.toThrow('identity conflict');
    await expect(
      commitRecords(f.db, scope, 'stale', {}, [{ previous: prior, data }]),
    ).rejects.toThrow('revision conflict');
    expect(
      f.sqlite
        .prepare("select * from learning_operations where id='stale'")
        .get(),
    ).toBeUndefined();
    await expect(
      requireRecord(f.db, { workspaceId: 'other', siteId: 's' }, id),
    ).rejects.toThrow('scope');
  });
  it('shares experience across Agents without creating another practice or counting reads', async () => {
    const f = fixture(),
      first = await ready(f, 'first'),
      second = await ready(f, 'second');
    task(f, 'reviewer', 'content_review');
    f.insert('learning_tasks', {
      task_id: 'reviewer',
      record_id: second,
      agent_id: 'content_review',
    });
    await adoptExperience(
      f.db,
      scope,
      'second',
      'topic_decision',
      first,
      'Choose a specific comparison',
      'Same claim and context',
      'adopt-topic',
      1,
    );
    await adoptExperience(
      f.db,
      scope,
      'reviewer',
      'content_review',
      first,
      'Check the boundary',
      'Same claim and context',
      'adopt-review',
      1,
    );
    expect((await taskLearning(f.db, scope, 'reviewer')).formed!.id).toBe(
      second,
    );
    expect(
      recordView(await requireRecord(f.db, scope, first)).utility
        .feedback_count,
    ).toBe(0);
    expect(
      f.sqlite.prepare('select count(*) n from learning_records').get(),
    ).toEqual({ n: 2 });
  });
  it('updates adopted history once per practice and replaces corrected feedback', async () => {
    const f = fixture(),
      first = await ready(f, 'first'),
      second = await ready(f, 'second');
    await adoptExperience(
      f.db,
      scope,
      'second',
      'topic_decision',
      first,
      'Use the failure lesson',
      'Same claim and outcome meaning',
      'adopt',
      1,
    );
    task(f, 'reviewer', 'content_review');
    f.insert('learning_tasks', {
      task_id: 'reviewer',
      record_id: second,
      agent_id: 'content_review',
    });
    await adoptExperience(
      f.db,
      scope,
      'reviewer',
      'content_review',
      first,
      'Preserve the caution',
      'Same claim',
      'adopt-review',
      1,
    );
    const unused = await ready(f, 'unused');
    task(f, 'learner', 'learning_agent');
    const t = (await taskForRun(f.db, 'learner'))!;
    const env = { DB: f.db } as RuntimeAgentEnv;
    const submit = async (key: string, clicks: number) => {
      await addEvidence(f.db, scope, second, key, 'outcome', 'gsc', {
        complete: true,
        values: { clicks: { value: clicks, unit: 'count' } },
      });
      f.sqlite
        .prepare(
          "update learning_requests set run_id='' where run_id='learner'",
        )
        .run();
      f.sqlite
        .prepare(
          "update learning_requests set run_id='learner',status='running' where id=?",
        )
        .run(`evidence:${key}`);
      const current = await requireRecord(f.db, scope, second),
        history = await requireRecord(f.db, scope, first);
      if (key === 'outcome1') {
        const tool = learningTools(env, t).resolve(
          agentDefinition('learning_agent'),
          'read_learning_request',
        );
        const view = (await tool.execute!({}, {} as never)) as {
          available_sources: Array<{ connection_state: string }>;
        };
        expect(view.available_sources[0].connection_state).toBe(
          'configuration_missing',
        );
      }
      const input: Parameters<typeof submitLearning>[3] = {
        observation_ref: await saveSlot(f.db, t, 'learning_record', {
          id: second,
          version: current.version,
        }),
        title: 'ignored',
        goal: 'Do not replace original',
        context: '',
        expectation: '',
        hypothesis: '',
        approach: '',
        adjustments: [],
        delivery: 'Published',
        evaluation: null,
        observation: null,
        conclusion: 'Observed outcomes',
        limitations: ['Association is not causation'],
        evidence_refs: [key],
        reward: null,
        compatible_uses: [
          {
            experience_id: first,
            observation_ref: await saveSlot(f.db, t, 'learning_record', {
              id: first,
              version: history.version,
            }),
            reason: 'Same business claim and compatible meaning',
          },
        ],
      };
      if (key === 'outcome1') {
        await expect(
          submitLearning(env, t, 'invalid-evidence', {
            ...input,
            evidence_refs: [key, 'wrong-ref'],
          }),
        ).rejects.toMatchObject({
          details: {
            kind: 'invalid_request',
            effects: 'none',
            issues: [
              {
                path: ['evidence_refs', 1],
                message:
                  'Evidence reference is not part of this practice: wrong-ref',
              },
            ],
          },
        });
        expect((await requireRecord(f.db, scope, second)).version).toBe(
          current.version,
        );
      }
      return submitLearning(env, t, `submit:${key}`, input);
    };
    await submit('outcome1', 10);
    let history = recordView(await requireRecord(f.db, scope, first));
    expect(history.utility.score).toBe(1);
    expect(history.utility.feedback_count).toBe(1);
    expect(
      recordView(await requireRecord(f.db, scope, unused)).utility.score,
    ).toBeNull();
    await submit('correction', 2);
    history = recordView(await requireRecord(f.db, scope, first));
    expect(history.utility.score).toBe(0.2);
    expect(history.utility.feedback_count).toBe(1);
    expect(
      recordView(await requireRecord(f.db, scope, second)).experience
        .evaluation,
    ).toEqual(agreement);
    expect(
      recordView(await requireRecord(f.db, scope, second)).utility.score,
    ).toBeNull();
  });
  it('persists failure receipts, skips after three failures and leaves the next practice enabled', async () => {
    const f = fixture();
    task(f, 'owner');
    const r = await createPractice(
      f.db,
      scope,
      'owner',
      'topic_decision',
      'Goal',
    );
    task(f, 'learner', 'learning_agent');
    f.sqlite
      .prepare(
        "update learning_requests set run_id='learner' where record_id=?",
      )
      .run(r.id);
    const env = { DB: f.db } as RuntimeAgentEnv,
      t = (await taskForRun(f.db, 'learner'))!;
    expect(
      await preparationFailure(env, t, 'request1', 'temporarily unavailable'),
    ).toBe(false);
    expect(
      await preparationFailure(env, t, 'request1', 'temporarily unavailable'),
    ).toBe(false);
    expect(
      await preparationFailure(env, t, 'request2', 'temporarily unavailable'),
    ).toBe(false);
    expect(
      await preparationFailure(env, t, 'request3', 'temporarily unavailable'),
    ).toBe(true);
    expect(
      recordView(await requireRecord(f.db, scope, r.id)).experience.preparation,
    ).toBe('skipped');
    expect(
      f.sqlite
        .prepare(
          'select failure_count from learning_requests where record_id=?',
        )
        .get(r.id),
    ).toEqual({ failure_count: 3 });
    task(f, 'next');
    const next = await createPractice(
      f.db,
      scope,
      'next',
      'topic_decision',
      'Next goal',
    );
    expect(recordView(next).experience.preparation).toBe('pending');
  });
  it('retains exact adoption receipts and rejects stale observations without altering a practice', async () => {
    const f = fixture(),
      first = await ready(f, 'first'),
      second = await ready(f, 'second');
    const result = await adoptExperience(
      f.db,
      scope,
      'second',
      'topic_decision',
      first,
      'Use failure lesson',
      'Same claim',
      'use-op',
      1,
    );
    expect(
      await adoptExperience(
        f.db,
        scope,
        'second',
        'topic_decision',
        first,
        'Use failure lesson',
        'Same claim',
        'use-op',
        1,
      ),
    ).toEqual(result);
    expect((await recordDetail(f.db, scope, second)).uses).toHaveLength(1);
    await expect(
      adoptExperience(
        f.db,
        scope,
        'second',
        'topic_decision',
        first,
        'changed',
        'Same claim',
        'use-op',
        1,
      ),
    ).rejects.toThrow('identity conflict');
    const current = await requireRecord(f.db, scope, first);
    await commitRecords(f.db, scope, 'new-history', {}, [
      { previous: current, data: JSON.parse(current.data_json) },
    ]);
    await expect(
      adoptExperience(
        f.db,
        scope,
        'second',
        'topic_decision',
        first,
        'late',
        'Same claim',
        'stale-use',
        1,
      ),
    ).rejects.toThrow('changed');
  });
  it('captures publication after the task closes and keeps its artifact version', async () => {
    const f = fixture(),
      id = await ready(f, 'topic');
    task(f, 'editor', 'content_production');
    f.insert('learning_tasks', {
      task_id: 'editor',
      record_id: id,
      agent_id: 'content_production',
    });
    f.insert('topic_decision_results', {
      id: 'decision',
      workspace_id: 'w',
      site_id: 's',
      run_id: 'topic',
      decision_type: 'topic_group',
      status: 'draft',
    });
    f.insert('content_production_groups', {
      decision_group_id: 'decision',
      id: 'group',
      workspace_id: 'w',
      site_id: 's',
      parent_run_id: 'editor',
    });
    f.insert('jobs', {
      id: 'job',
      site_id: 's',
      production_group_id: 'group',
      status: 'awaiting_review',
      current_artifact_id: 'artifact-v2',
      versions_json: '[{"locale":"en","slug":"lesson"}]',
    });
    f.sqlite
      .prepare(
        "update agent_tasks set status='completed' where id in ('topic','editor')",
      )
      .run();
    f.sqlite
      .prepare(
        "update jobs set status='published',published_at='2026-10-01T12:00:00Z' where id='job'",
      )
      .run();
    const evidence = f.sqlite
      .prepare(
        "select payload_json from learning_evidence where kind='publication'",
      )
      .get() as { payload_json: string };
    expect(JSON.parse(evidence.payload_json)).toMatchObject({
      artifact_id: 'artifact-v2',
      published_at: '2026-10-01T12:00:00Z',
    });
    expect(
      f.sqlite
        .prepare(
          "select status from learning_requests where id='publication:job:artifact-v2'",
        )
        .get(),
    ).toEqual({ status: 'pending' });
    expect(
      f.sqlite.prepare("select status from agent_tasks where id='topic'").get(),
    ).toEqual({ status: 'completed' });
  });
  it('inherits one practice across author tasks and keeps older task contracts untouched', async () => {
    const f = fixture(),
      id = await ready(f, 'topic');
    task(f, 'author', 'article_production');
    f.sqlite
      .prepare(
        "update agent_tasks set parent_task_id='topic',definition_version=24 where id='author'",
      )
      .run();
    const author = (await taskForRun(f.db, 'author'))!;
    expect(supportsLearning(author)).toBe(true);
    expect(
      (await attachPractice({ DB: f.db } as RuntimeAgentEnv, author))?.id,
    ).toBe(id);
    expect(supportsLearning({ ...author, definition_version: 23 })).toBe(false);
    expect(
      f.sqlite.prepare('select count(*) n from learning_records').get(),
    ).toEqual({ n: 1 });
  });
  it('pages formal evidence without losing earlier material and rolls back multi-record conflicts', async () => {
    const f = fixture(),
      first = await ready(f, 'first'),
      second = await ready(f, 'second');
    for (let i = 0; i < 53; i++)
      f.insert('learning_evidence', {
        id: `e${String(i).padStart(3, '0')}`,
        record_id: first,
        kind: 'report',
        source_ref: 'formal',
        payload_json: '{}',
      });
    const detail = await recordDetail(f.db, scope, first);
    expect(detail.evidence).toHaveLength(50);
    const page = await learningPage(
      f.db,
      scope,
      first,
      'evidence',
      detail.next_cursors.evidence,
    );
    expect(page.items).toHaveLength(3);
    expect(page.next_cursor).toBeNull();
    const a = await requireRecord(f.db, scope, first),
      b = await requireRecord(f.db, scope, second);
    await expect(
      commitRecords(f.db, scope, 'conflict-batch', {}, [
        { previous: a, data: JSON.parse(a.data_json) },
        { previous: { ...b, version: 0 }, data: JSON.parse(b.data_json) },
      ]),
    ).rejects.toThrow();
    expect((await requireRecord(f.db, scope, first)).version).toBe(a.version);
  });
  it('reads a durable commit receipt after the database response is lost', async () => {
    const f = fixture(),
      id = await ready(f, 'first'),
      previous = await requireRecord(f.db, scope, id);
    const batch = f.db.batch;
    f.db.batch = (async (statements) => {
      await batch(statements);
      throw new Error('Response lost after commit');
    }) as typeof batch;
    const saved = await commitRecords(f.db, scope, 'uncertain-response', {}, [
      { previous, data: JSON.parse(previous.data_json) },
    ]);
    expect(saved.version).toBe(previous.version + 1);
    expect(
      f.sqlite
        .prepare(
          "select count(*) n from learning_operations where id='uncertain-response'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });
});
