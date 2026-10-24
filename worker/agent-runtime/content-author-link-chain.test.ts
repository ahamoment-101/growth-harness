// These tests isolate editorial/domain contracts; learning orchestration has its own Runtime acceptance.
vi.mock('../learning/business', async () => { const runtime = await import('./conversation-runtime'); return { runBusinessConversationTask: runtime.runConversationTask }; });
import { expect, it, vi } from 'vitest';
import { contentLinkFixture } from './content-links.test-fixture';
import { runContentParentConversation } from './content-parent-conversation';
import { runArticleConversation, runReviewConversation } from './content-conversations';
import { runConversationTask } from './conversation-runtime';
import { isolatedReview } from './isolated-review';
import { agentDefinition } from './definitions';
import { saveSlot } from './parameter-slots';
import { persistRuntimeJson } from './runtime-content';
import { beginTaskDecision, finishTaskOperation, requireTask, setTaskAction } from './task-store';
import { contentProductionGroupPayload, contentProductionPayload, type ArticleTask, type ContentReviewTask } from './content-production';
import type { AgentModuleExecutionContext } from './agent-modules';
import type { AgentRun } from './protocol';
import { AUTHOR_CONTENT_LINK_REQUIREMENTS, AUTHOR_CONTENT_LINK_REQUIREMENT_INSTRUCTIONS } from './content-link-policy';

// One article through the user-facing chain with real tool executors and SQLite; only model calls and Workflow starts are replaced.
vi.mock('./conversation-runtime', () => ({ runConversationTask: vi.fn(async () => ({ status: 'waiting', output: {} })) }));
vi.mock('./child-run-wait', () => ({ waitForChildRuns: async () => [] }));
vi.mock('./isolated-review', () => ({ isolatedReview: vi.fn(async () => ({ summary: 'No major issues', findings: [] })) }));

const answer = 'State the next step clearly.';
const body = (link: string) => `## Reply\n\nOpen with the decision you need.\n\n${answer}\n\nUse ${link} before sending.`;

it('dispatches, writes with author links, reviews content and links, revises and reaches human review without parent link work', async () => {
  const f = await contentLinkFixture();
  f.sqlite.exec(`update content_artifacts set status='rejected' where id='draft';
    alter table content_production_groups add column created_at text default '';`);
  const parentRun = f.sqlite.prepare("select * from agent_runs where id='parent'").get() as AgentRun;
  parentRun.definition_version = 20; parentRun.summary_json = JSON.stringify({ group_id: 'g' });
  const startChildRun = vi.fn(async (value: { runId: string }) => ({ id: value.runId }));
  await runContentParentConversation({ env: f.p.env, run: parentRun, definition: agentDefinition('content_production'), startChildRun, step: {} } as unknown as AgentModuleExecutionContext);
  const parent = vi.mocked(runConversationTask).mock.calls.at(-1)![0];
  expect(parent.agent.tools(f.p.task, f.op).names().filter((name: string) => /link|read_content|published/.test(name))).toEqual([]);
  expect(parent.agent.instructions).toContain('Authors place internal links while writing');
  expect(parent.agent.instructions).toContain(AUTHOR_CONTENT_LINK_REQUIREMENT_INSTRUCTIONS);
  expect(await parent.agent.context(f.p.task)).toMatchObject({ internal_linking: { requirements: AUTHOR_CONTENT_LINK_REQUIREMENTS,
    product_targets: [{ locale: 'en', kind: 'product', link: 'https://example.com/product', verification: 'site_configuration' }] } });
  await finishTaskOperation(f.p.env.DB, f.p.task, f.op, {});

  const parentCall = async (name: string, observation: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const task = await requireTask(f.p.env.DB, 'parent');
    const observation_ref = await saveSlot(f.p.env.DB, task, 'content_group', { group: { id: 'g' }, items: [{ job_id: 'j', decision_item_id: 'item', job_status: 'drafting', parent_review: {}, review_note: '', ...observation }] });
    const operation = await beginTaskDecision(f.p.env.DB, task, {});
    const args = { observation_ref, job_ids: ['j'], judgment_summary: name, ...extra };
    await setTaskAction(f.p.env.DB, task, operation, { name, input: args });
    await parent.agent.tools(task, operation).resolve(agentDefinition('content_production'), name).execute!(args, { ...f.context, idempotencyKey: operation.id });
    await finishTaskOperation(f.p.env.DB, task, operation, {});
    return startChildRun.mock.calls.at(-1)![0] as unknown as { initialAssignment: { material: Record<string, any> } };
  };
  const planTask = await requireTask(f.p.env.DB, 'parent');
  const coverage_ref = await saveSlot(f.p.env.DB, planTask, 'content_coverage', { job_id: 'j', revision: 1, previous_plan_ref: '', reader_task: 'Reply', distinct_value: 'Steps',
    requirements: [{ id: 'q', question: 'How?', importance: 'core', reason: 'Task', basis: 'hypothesis', evidence_refs: [], page_scope: 'this_page' }] });

  // 1. The parent assigns writing under the author-owned link contract.
  const writing = await parentCall('start_article_tasks', { artifact_id: 'draft', artifact_status: 'rejected', attempt: 1 }, { editorial_brief: 'Practical reply guide', coverage_plans: [{ job_id: 'j', coverage_ref }] });
  const assigned = writing.initialAssignment.material as ArticleTask;
  expect(assigned).toMatchObject({ author_link_contract: 1, editorial_contract_version: 2, attempt: 2, previous_artifact_id: 'draft' });

  // 2. The author finds a target, saves, is checked in a fresh session and delivers.
  const author = await f.task('author', 'article_production', assigned);
  const authorRun = f.sqlite.prepare("select * from agent_runs where id='author'").get() as AgentRun;
  // A run pinned before v18 keeps writing without the research-first instructions.
  await runArticleConversation({ env: author.env, run: { ...authorRun, definition_version: 17 }, definition: agentDefinition('article_production') } as AgentModuleExecutionContext);
  expect(vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent.instructions).not.toContain('Research before writing');
  await runArticleConversation({ env: author.env, run: { ...authorRun, definition_version: 18 }, definition: agentDefinition('article_production') } as AgentModuleExecutionContext);
  const authorAgent = vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent;
  expect(authorAgent.instructions).toContain('Research before writing');
  expect(authorAgent.instructions).not.toContain('Use article_search_web when factual gaps need investigation');
  const authorTools = () => authorAgent.tools();
  let tools = authorTools();
  const authorCall = async (name: string, raw: unknown, key: string) => (await tools.resolve(agentDefinition('article_production'), name).execute!(tools.resolve(agentDefinition('article_production'), name).inputSchema.parse(raw), { ...author.context, idempotencyKey: key })) as Record<string, any>;
  const targets = await authorCall('find_link_targets', { locale: 'en', query: 'checklist', include: ['published'], judgment_summary: 'Find' }, 'author:find');
  const link = `[a detailed checklist](${targets.targets[0].link})`;
  const ledger_ref = await saveSlot(author.env.DB, author.task, 'content_evidence', { job_id: 'j', revision: 1, previous_ledger_ref: '', claims: [] });
  const draft = (content: string) => ({ bundle: { versions: [{ locale: 'en', slug: 'reply-guide', title: 'Reply guide', excerpt: 'Write a reply', content }], ledger_ref,
    coverage_response: [{ requirement_id: 'q', status: 'answered', explanation: 'Steps', locations: [{ locale: 'en', quote: answer }] }],
    seo_contract: { search_intent: 'Reply', reader_value: 'Steps', direct_answer: answer, primary_keyword: 'reply', supporting_terms: [], geo_summary: 'Reply' } }, judgment_summary: 'Draft' });
  const saved = await authorCall('save_article_draft', draft(body(link)), 'author:save-1');
  expect(saved).toMatchObject({ accepted: true, self_check: { findings: [] } });
  const delivered = await authorCall('deliver_article', { draft_ref: saved.draft_ref, check_ref: saved.check_ref, declined_findings: [], judgment_summary: 'Deliver' }, 'author:deliver-1');
  expect(delivered).toMatchObject({ accepted: true, attempt: 2 });

  // 3. Review dispatch carries a host-derived internal link list and the self-check; the reviewer applies the link contract.
  const reviewDispatch = await parentCall('start_content_reviews', { artifact_id: delivered.artifact_id, artifact_status: 'candidate', attempt: 2 });
  const reviewMaterial = reviewDispatch.initialAssignment.material as ContentReviewTask;
  expect(reviewMaterial.internal_links).toEqual([expect.objectContaining({ anchor_text: 'a detailed checklist', target: expect.objectContaining({ kind: 'published', title: 'Checklist' }) })]);
  expect(reviewMaterial.seo_contract).toHaveProperty('self_check');
  expect(reviewMaterial.versions[0]).toHaveProperty('content', body(link));
  expect(reviewMaterial.versions[0]).not.toHaveProperty('content_chunks');
  const reviewer = await f.task('reviewer', 'content_review', reviewMaterial);
  const reviewerRun = f.sqlite.prepare("select * from agent_runs where id='reviewer'").get() as AgentRun;
  await f.db.prepare("update agent_runs set parent_run_id='parent' where id='reviewer'").run();
  await runReviewConversation({ env: reviewer.env, run: { ...reviewerRun, parent_run_id: 'parent', definition_version: 10 }, definition: agentDefinition('content_review') } as AgentModuleExecutionContext);
  expect(vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent.instructions).not.toContain('real understanding of the subject');
  await runReviewConversation({ env: reviewer.env, run: { ...reviewerRun, parent_run_id: 'parent', definition_version: 11 }, definition: agentDefinition('content_review') } as AgentModuleExecutionContext);
  expect(vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent.instructions).toContain('real understanding of the subject');
  expect(vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent.instructions).not.toContain('exact continuous article Markdown');
  await runReviewConversation({ env: reviewer.env, run: { ...reviewerRun, parent_run_id: 'parent', definition_version: 13 }, definition: agentDefinition('content_review') } as AgentModuleExecutionContext);
  expect(vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent.instructions).toContain('exact continuous article Markdown');
  const reviewTool = vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent.tools().resolve(agentDefinition('content_review'), 'submit_content_review');
  expect(reviewTool.version).toBe(3);
  const judgments = { value_assessment: 'Useful', seo_geo_risks: [], coverage_findings: [{ requirement_id: 'q', assessment: 'answered', locations: [{ locale: 'en', quote: answer }], explanation: 'Steps are clear', recommended_change: '' }], evidence_findings: [], seo_strategy_assessment: 'Matches intent', topic_requirement_assessment: 'Delivered', author_self_check_assessment: 'Holds up', judgment_summary: 'Review' };
  await reviewTool.execute!(reviewTool.inputSchema.parse({ ...judgments, decision: 'revise', required_changes: ['Change the checklist link to a target that better fits the reply approach'], link_assessment: 'Target doesn\'t fit',
    link_findings: [{ locale: 'en', anchor_text: 'a detailed checklist', target: 'Checklist', problem: 'The goal is a pre-send check', recommended_change: 'Writing exercise linking to the product page' }] }), reviewer.context);
  expect(f.sqlite.prepare('select status from content_artifacts where id=?').get(delivered.artifact_id)).toEqual({ status: 'rejected' });

  // 4. The parent forwards the review; the author revises in a new assignment and the link contract travels with it.
  const revision = await parentCall('start_article_tasks', { artifact_id: delivered.artifact_id, artifact_status: 'rejected', attempt: 2,
    parent_review: { required_changes: ['Change the checklist link to a target that better fits the reply approach'] } }, { editorial_brief: 'Apply the review', coverage_plans: [{ job_id: 'j', coverage_ref }] });
  const revised = revision.initialAssignment.material as ArticleTask;
  expect(revised).toMatchObject({ author_link_contract: 1, attempt: 3, editorial_feedback: { link_findings: [{ anchor_text: 'a detailed checklist' }] } });
  f.sqlite.prepare('insert into agent_task_assignments(id,task_id,operation_id,context_json,created_at) values(?,?,?,?,?)').run('author:revision', 'author', 'author:revision', await persistRuntimeJson(f.db, revised), 'now');
  f.sqlite.prepare("update agent_tasks set assignment_id='author:revision' where id='author'").run();
  tools = authorTools();
  const product = await authorCall('find_link_targets', { locale: 'en', include: ['product'], judgment_summary: 'Product' }, 'author:find-2');
  await expect(authorCall('deliver_article', { draft_ref: saved.draft_ref, check_ref: saved.check_ref, declined_findings: [], judgment_summary: 'Stale' }, 'author:deliver-stale')).rejects.toThrow('earlier assignment');
  const resaved = await authorCall('save_article_draft', draft(body(`[writing practice](${product.targets[0].link})`)), 'author:save-2');
  const redelivered = await authorCall('deliver_article', { draft_ref: resaved.draft_ref, check_ref: resaved.check_ref, declined_findings: [], judgment_summary: 'Deliver revision' }, 'author:deliver-2');
  expect(redelivered).toMatchObject({ accepted: true, attempt: 3 });

  // 5. A pass sends the article to human review; no parent link step exists.
  const secondReview = await parentCall('start_content_reviews', { artifact_id: redelivered.artifact_id, artifact_status: 'candidate', attempt: 3 });
  const secondMaterial = secondReview.initialAssignment.material as ContentReviewTask;
  expect(secondMaterial.versions[0]).toHaveProperty('content', body(`[writing practice](${product.targets[0].link})`));
  expect(secondMaterial.internal_links).toEqual([expect.objectContaining({ anchor_text: 'writing practice', target: expect.objectContaining({ kind: 'product' }) })]);
  f.sqlite.prepare('insert into agent_task_assignments(id,task_id,operation_id,context_json,created_at) values(?,?,?,?,?)').run('reviewer:2', 'reviewer', 'reviewer:2', await persistRuntimeJson(f.db, { ...secondMaterial, artifact_id: redelivered.artifact_id }), 'now');
  f.sqlite.prepare("update agent_tasks set assignment_id='reviewer:2' where id='reviewer'").run();
  await reviewTool.execute!(reviewTool.inputSchema.parse({ ...judgments, decision: 'pass', required_changes: [], link_assessment: 'The product page link fits the reader\'s next step' }),
    { ...reviewer.context, idempotencyKey: 'reviewer:operation-2' });
  expect(f.sqlite.prepare("select status, current_artifact_id from jobs where id='j'").get()).toEqual({ status: 'awaiting_review', current_artifact_id: redelivered.artifact_id });

  // 6. The group detail exposes the self-check and link counts; the polled list stays lean.
  const detail = await contentProductionGroupPayload(f.db, 'w', 's', 'g');
  expect(detail.group.items[0]).toMatchObject({ self_check: { summary: 'No major issues' }, internal_link_counts: [{ locale: 'en', internal_links: 1 }] });
  const list = await contentProductionPayload(f.db, 'w', 's');
  expect(list.groups[0].items[0]).not.toHaveProperty('internal_link_counts');
  expect(isolatedReview).toHaveBeenCalledTimes(2);
});
