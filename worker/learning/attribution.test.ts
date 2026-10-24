// @ts-ignore Node-only migration fixture.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import { createPractice, learningPage } from './store';
import { validateFindings, type LearningFinding } from './attribution';
import { taskSubjectsJson } from '../agent-runtime/task-subjects';

const scope = { workspaceId: 'w', siteId: 's' };
async function fixture(beforeMigration?: string) {
  const f = schemaTestDb({ beforeMigration });
  f.insert('workspaces', { id: 'w' }); f.insert('sites', { id: 's', workspace_id: 'w' });
  const task = (id: string, parent = '', agent = 'content_review') => {
    f.insert('agent_runs', { id, workspace_id: 'w', site_id: 's', agent_id: agent, agent_instance_id: id, status: 'running', root_run_id: parent || id });
    f.insert('agent_tasks', { id, active_run_id: id, workspace_id: 'w', site_id: 's', agent_id: agent, agent_instance_id: id, status: 'running', parent_task_id: parent, root_task_id: 'leader', execution_id: `exec-${id}` });
  };
  task('leader', '', 'growth_leader');
  const practice = await createPractice(f.db, scope, 'leader', 'growth_leader', 'Compare two deliveries');
  const assign = (id: string, assignment: string, job: string, version: string) => {
    f.insert('agent_task_assignments', { id: assignment, task_id: id, operation_id: assignment, subjects_json: taskSubjectsJson([{ type: 'job', id: job, version }]) });
    f.sqlite.prepare('update agent_tasks set assignment_id=? where id=?').run(assignment, id);
  };
  const report = (id: string, reason: string) => f.sqlite.prepare("update agent_tasks set status='waiting',reason=? where id=?").run(reason, id);
  const group = (parent: string) => {
    f.insert('topic_decision_results', { id: 'decision', workspace_id: 'w', site_id: 's', run_id: 'leader', decision_type: 'topic_group', status: 'draft' });
    f.insert('topic_decision_items', { id: 'item', result_id: 'decision' });
    f.insert('content_production_groups', { id: 'group', workspace_id: 'w', site_id: 's', decision_group_id: 'decision', parent_run_id: parent, status: 'producing' });
  };
  return { ...f, task, assign, report, practice, group };
}
const finding = (id: string, version: string | null, evidence: string[]): LearningFinding => ({
  scope: 'object', subjects: [{ type: 'job', id, version }], kind: 'conclusion', text: 'Formal outcome', evidence_refs: evidence,
});
describe('durable learning attribution', () => {
  it('keeps deep descendants in one practice and freezes each report across reassignment and out-of-order delivery', async () => {
    const f = await fixture();
    f.task('parent', 'leader', 'content_production');
    f.assign('parent', 'parent-first', 'job-a', 'artifact-a1');
    f.task('a', 'parent'); f.assign('a', 'a-first', 'job-a', 'artifact-a1');
    f.task('a-child', 'a', 'deep_research'); f.task('a-grandchild', 'a-child', 'business_research');
    f.task('b', 'parent'); f.assign('b', 'b-first', 'job-b', 'artifact-b1');
    f.report('b', 'deferred'); f.report('a', 'pass'); f.report('a-grandchild', 'evidence complete');
    const page = await learningPage(f.db, scope, f.practice.id, 'evidence');
    const reports = page.items as Array<{ id: string; source_ref: string; attribution: { subjects: unknown[] } }>;
    const a = reports.find(r => r.source_ref === 'a')!, b = reports.find(r => r.source_ref === 'b')!;
    expect(reports.find(r => r.source_ref === 'a-grandchild')!.attribution.subjects).toEqual([{ type: 'job', id: 'job-a', version: 'artifact-a1' }]);
    f.assign('parent', 'parent-second', 'job-a', 'artifact-a2');
    f.assign('a', 'a-second', 'job-a', 'artifact-a2');
    f.sqlite.prepare("update agent_tasks set status='running',execution_id='exec-a2' where id='a'").run();
    f.report('a', 'revise'); f.report('a', 'revise'); // replay of same status produces no second feedback
    const updated = await learningPage(f.db, scope, f.practice.id, 'evidence');
    expect(updated.items).toHaveLength(4);
    expect(updated.items.find(r => 'id' in r && r.id === a.id)).toMatchObject({ attribution: { parent_assignment_id: 'parent-first' } });
    expect(updated.items.find(r => 'id' in r && r.id !== a.id && 'source_ref' in r && r.source_ref === 'a')).toMatchObject({ attribution: { parent_assignment_id: 'parent-second' } });
    expect(updated.items.find(r => 'id' in r && r.id === a.id)).toMatchObject({ attribution: { subjects: [{ type: 'job', id: 'job-a', version: 'artifact-a1' }] } });
    await expect(validateFindings(f.db, f.practice.id, [finding('job-a', 'artifact-a1', [a.id])])).resolves.toBeUndefined();
    await expect(validateFindings(f.db, f.practice.id, [finding('job-a', 'artifact-a1', [b.id])])).rejects.toThrow('attribution mismatch');
    await expect(validateFindings(f.db, f.practice.id, [finding('job-a', 'artifact-a2', [a.id])])).rejects.toThrow('attribution mismatch');
    await expect(validateFindings(f.db, 'another-practice', [finding('job-a', null, [a.id])])).rejects.toThrow('attribution mismatch');
    await expect(validateFindings(f.db, f.practice.id, [{ scope: 'practice', subjects: [], kind: 'conclusion', text: 'One pass and one deferral for different objects', evidence_refs: [a.id, b.id] }])).resolves.toBeUndefined();
    expect(f.sqlite.prepare('select count(*) as n from learning_requests where phase=?').get('record')).toEqual({ n: 4 });
  });

  it('upgrades old evidence conservatively and freezes real publication versions after parent completion', async () => {
    const f = await fixture('0085_task_subjects.sql');
    f.task('parent', 'leader', 'content_production');
    f.task('reviewer', 'parent');
    f.sqlite.prepare("update agent_tasks set goal_json=? where id='reviewer'").run(JSON.stringify({ job_id: 'job-a', artifact_id: 'old-version' }));
    f.group('parent');
    f.insert('jobs', { id: 'job-a', site_id: 's', production_group_id: 'group', current_artifact_id: 'new-version', status: 'awaiting_review' });
    f.insert('content_artifacts', { id: 'new-version', job_id: 'job-a', group_id: 'group', decision_item_id: 'item', status: 'candidate' });
    f.report('reviewer', 'deferred without an artifact receipt');
    const oldData = f.sqlite.prepare('select version,data_json from learning_records where id=?').get(f.practice.id);
    for (const file of ['0085_task_subjects.sql', '0086_learning_attribution.sql'])
      f.sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url).pathname, 'utf8'));
    expect(f.sqlite.prepare('select version,data_json from learning_records where id=?').get(f.practice.id)).toEqual(oldData);
    const oldPage = await learningPage(f.db, scope, f.practice.id, 'evidence');
    expect(oldPage.items[0]).toMatchObject({ attribution: { subjects: [{ type: 'job', id: 'job-a', version: null }] } });
    f.sqlite.prepare("update agent_tasks set status='completed' where id='parent'").run();
    f.sqlite.prepare("update jobs set status='published',published_at='2026-10-24T00:00:00Z' where id='job-a'").run();
    const page = await learningPage(f.db, scope, f.practice.id, 'evidence');
    expect(page.items.find(e => 'kind' in e && e.kind === 'publication')).toMatchObject({ attribution: { subjects: [{ type: 'job', id: 'job-a', version: 'new-version' }] } });
    expect(f.sqlite.prepare("select count(*) as n from learning_requests where id='publication:job-a:new-version'").get()).toEqual({ n: 1 });
  });

  it('binds a newly created artifact from its formal delivery without borrowing another job artifact', async () => {
    const f = await fixture(); f.task('author', 'leader', 'article_production'); f.group('leader');
    f.insert('jobs', { id: 'job-a', site_id: 's', status: 'drafting' });
    f.insert('content_artifacts', { id: 'artifact-a', job_id: 'job-a', group_id: 'group', decision_item_id: 'item', status: 'candidate' });
    f.insert('agent_task_assignments', { id: 'write-a', task_id: 'author', operation_id: 'write-a', subjects_json: taskSubjectsJson([{ type: 'job', id: 'job-a', version: null }]) });
    f.sqlite.prepare("update agent_tasks set assignment_id='write-a' where id='author'").run();
    f.sqlite.prepare("update agent_tasks set output_json=? where id='author'").run(JSON.stringify({ job_id: 'job-a', artifact_id: 'artifact-a', outcome: 'submitted' }));
    f.report('author', 'Delivered');
    const page = await learningPage(f.db, scope, f.practice.id, 'evidence');
    expect(page.items[0]).toMatchObject({ attribution: { subjects: [{ type: 'job', id: 'job-a', version: 'artifact-a' }] } });
    expect(f.sqlite.prepare("select subjects_json from agent_task_assignments where id='write-a'").get()).toEqual({ subjects_json: '[{"type":"job","id":"job-a","version":null}]' });
    f.task('author-b', 'leader', 'article_production');
    f.insert('jobs', { id: 'job-b', site_id: 's', status: 'drafting' });
    f.insert('agent_task_assignments', { id: 'write-b', task_id: 'author-b', operation_id: 'write-b', subjects_json: taskSubjectsJson([{ type: 'job', id: 'job-b', version: null }]) });
    f.sqlite.prepare("update agent_tasks set assignment_id='write-b',output_json=? where id='author-b'").run(JSON.stringify({ job_id: 'job-b', artifact_id: 'artifact-a' }));
    f.report('author-b', 'Unverified reference');
    const second = await learningPage(f.db, scope, f.practice.id, 'evidence');
    expect(second.items.find(e => 'source_ref' in e && e.source_ref === 'author-b')).toMatchObject({ attribution: { subjects: [{ type: 'job', id: 'job-b', version: null }] } });
  });

  it('keeps unknown attribution unknown and prevents assignment identity changes', async () => {
    const f = await fixture(); f.task('unassigned', 'leader'); f.report('unassigned', 'Partial evidence');
    const page = await learningPage(f.db, scope, f.practice.id, 'evidence');
    const ref = (page.items[0] as { id: string }).id;
    await expect(validateFindings(f.db, f.practice.id, [finding('job-a', null, [ref])])).rejects.toThrow('attribution mismatch');
    await expect(validateFindings(f.db, f.practice.id, [{ scope: 'unknown', subjects: [], kind: 'limitation', text: 'Object is not known', evidence_refs: [ref] }])).resolves.toBeUndefined();
    f.task('a', 'leader'); f.assign('a', 'a-first', 'job-a', 'v1');
    expect(() => f.sqlite.prepare("update agent_task_assignments set subjects_json='[]' where id='a-first'").run()).toThrow('immutable');
    expect(() => f.sqlite.prepare("update agent_tasks set assignment_id='a-first' where id='unassigned'").run()).toThrow('another task');
  });
});
