import { beforeEach, describe, expect, it, vi } from 'vitest';
import { contentLinkFixture } from './content-links.test-fixture';
import { editorialFixture } from './content-editorial.test-fixture';
import { runArticleConversation, runReviewConversation } from './content-conversations';
import { runConversationTask } from './conversation-runtime';
import { isolatedReview } from './isolated-review';
import { agentDefinition } from './definitions';
import { saveSlot } from './parameter-slots';
import { persistRuntimeJson, readRuntimeJson } from './runtime-content';
import { ToolExecutionError } from './tool-failure';
import { ARTICLE_SELF_CHECK_INSTRUCTIONS } from './content-self-check';
import { describeContentInternalLinks } from './content-link-policy';
import type { ArticleTask } from './content-production';
import type { AgentModuleExecutionContext } from './agent-modules';
import type { CoveragePlan } from './content-editorial';

vi.mock('./conversation-runtime', () => ({ runConversationTask: vi.fn(async () => ({ status: 'waiting', output: {} })) }));
vi.mock('./isolated-review', () => ({ isolatedReview: vi.fn() }));
beforeEach(() => vi.mocked(isolatedReview).mockReset());

const plan: CoveragePlan = { job_id: 'j', revision: 1, previous_plan_ref: '', reader_task: 'Write a reply', distinct_value: 'Example', requirements: [{ id: 'question', question: 'How?', importance: 'core', reason: 'User task', basis: 'hypothesis', evidence_refs: [], page_scope: 'this_page' }] };
const answer = 'State the next step clearly.';
const linked = (links: string) => `## Reply\n\nIn today's fast-paced world, replies matter.\n\n${answer}\n\n${links}`;
const oneLink = linked('Use a [reply checklist](article:old) before sending.');

async function authorFixture() {
  const f = await contentLinkFixture();
  const article: ArticleTask = { editorial_contract_version: 2, author_link_contract: 1, coverage_plan: plan, group_id: 'g', job_id: 'j', decision_group_id: 'decision', decision_item_id: 'item', source_locale: 'en', locales: ['en'],
    hub_path: '/product', hub_urls: {}, product_origin: 'https://example.com', blog_origin: 'https://blog.example.com', published_articles: [],
    group_articles: [{ job_id: 'sib', title_direction: 'Reply templates for customers', primary_keyword: 'reply templates', locale: 'en' }],
    topic: { primary_keyword: 'reply' }, group: {}, business_context: ['Product writes nothing for users'], strategy_context: [], evidence: [], attempt: 2, editorial_brief: 'Practical reply guide', parent_feedback: [], previous_artifact_id: 'draft' };
  const a = await f.task('author', 'article_production', article);
  const run = f.sqlite.prepare('select * from agent_runs where id=?').get('author');
  await runArticleConversation({ env: a.env, run, definition: agentDefinition('article_production') } as AgentModuleExecutionContext);
  const agent = vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent;
  const tools = agent.tools();
  const ledger_ref = await saveSlot(a.env.DB, a.task, 'content_evidence', { job_id: 'j', revision: 1, previous_ledger_ref: '', claims: [] });
  const draft = (content: string) => ({ bundle: { versions: [{ locale: 'en', slug: 'reply-guide', title: 'Reply guide', excerpt: 'Write a reply', content }], ledger_ref,
    coverage_response: [{ requirement_id: 'question', status: 'answered', explanation: 'Example', locations: [{ locale: 'en', quote: answer }] }],
    seo_contract: { search_intent: 'Write a reply', reader_value: 'An example', direct_answer: answer, primary_keyword: 'reply', supporting_terms: [], geo_summary: 'Reply guidance' } }, judgment_summary: 'Draft' });
  const call = async (name: string, raw: unknown, key: string) => {
    const tool = tools.resolve(agentDefinition('article_production'), name);
    const output = await tool.execute!(tool.inputSchema.parse(raw), { ...a.context, idempotencyKey: key });
    return { output: output as Record<string, any>, completion: tool.completion?.(output) };
  };
  return { ...f, a, agent, tools, draft, call, article };
}

describe('author-owned internal links and fresh self-check', () => {
  it('finds published, sibling and product targets with the exact link form to write', async () => {
    const f = await authorFixture();
    expect(f.agent.instructions).toContain('You own the internal links of this article');
    const published = (await f.call('find_link_targets', { locale: 'en', query: 'detailed checklist', include: ['published'], judgment_summary: 'Targets' }, 'author:find-1')).output;
    expect(published.total_matches).toBe(7);
    expect(published.targets[0]).toMatchObject({ kind: 'published', link: expect.stringMatching(/^article:old/), url: expect.stringContaining('checklist') });
    expect(published.targets[0].snippet.toLowerCase()).toContain('detailed checklist');
    const others = (await f.call('find_link_targets', { locale: 'en', query: 'templates', include: ['siblings', 'product'], judgment_summary: 'Targets' }, 'author:find-2')).output;
    expect(others.targets).toEqual([
      expect.objectContaining({ kind: 'sibling', link: 'article:sib', url: null }),
      expect.objectContaining({ kind: 'product', link: 'https://example.com/product' }),
    ]);
    expect((await f.call('find_link_targets', { locale: 'pt-BR', judgment_summary: 'Wrong locale' }, 'author:find-3')).output.error).toContain('not part of this article');
  });

  it('rejects drafts with no internal link, more than three or an unavailable target before any self-check', async () => {
    const f = await authorFixture();
    const issues = async (content: string, key: string) => ((await f.call('save_article_draft', f.draft(content), key)).output.issues as Array<{ code: string }>).map(issue => issue.code);
    expect(await issues(linked('No links here.'), 'author:save-none')).toContain('internal_links_missing');
    expect(await issues(linked('[a](article:old) [b](article:old-1) [c](article:sib) [d](https://example.com/product)'), 'author:save-four')).toContain('internal_links_over_limit');
    expect(await issues(linked('See [missing guide](article:missing).'), 'author:save-missing')).toContain('internal_link_target_unavailable');
    expect(isolatedReview).not.toHaveBeenCalled();
  });

  it('checks each saved draft in a fresh session and delivers only a checked candidate with dispositions', async () => {
    const f = await authorFixture();
    expect(f.tools.names()).toEqual(expect.arrayContaining(['find_link_targets', 'save_article_draft', 'run_self_check', 'deliver_article']));
    expect(f.tools.names()).not.toContain('submit_article');
    expect(f.agent.auditCompletionTools).toEqual(['deliver_article']);

    vi.mocked(isolatedReview).mockResolvedValueOnce({ summary: 'The opening is boilerplate', findings: [{ category: 'ai_style', locale: 'en', quote: "In today's fast-paced world, replies matter.", problem: 'Boilerplate opening', suggestion: 'Give the reply steps directly' }] });
    const saved = (await f.call('save_article_draft', f.draft(oneLink), 'author:save-1')).output;
    const request = vi.mocked(isolatedReview).mock.calls[0][0];
    expect(request.instructions).toBe(ARTICLE_SELF_CHECK_INSTRUCTIONS);
    // The fresh session receives the saved text and requirements, never the author's conversation.
    expect(Object.keys(request.material as object).sort()).toEqual(['article', 'product_facts', 'requirements', 'stated_contract']);
    expect(saved).toMatchObject({ accepted: true, draft_ref: expect.any(String), check_ref: expect.any(String), self_check: { findings: [{ id: 'f1', category: 'ai_style' }] } });
    expect(f.sqlite.prepare("select count(*) n from content_artifacts where job_id='j' and child_run_id='author' and submission_operation_id like 'author:%'").get()).toEqual({ n: 0 });

    const delivery = { draft_ref: saved.draft_ref, check_ref: saved.check_ref, declined_findings: [], judgment_summary: 'Deliver' };
    await expect(f.call('deliver_article', delivery, 'author:deliver-0')).rejects.toThrow('Decline each finding');

    const revisedBody = `## Reply\n\nOpen with the decision you need.\n\n${answer}\n\nUse a [reply checklist](article:old) before sending.`;
    vi.mocked(isolatedReview).mockResolvedValueOnce({ summary: 'Ready to deliver', findings: [{ category: 'other', locale: 'en', quote: '', problem: 'Could add one more example', suggestion: 'Add a supplementary example' }] });
    const revised = (await f.call('save_article_draft', f.draft(revisedBody), 'author:save-2')).output;
    await expect(f.call('deliver_article', { ...delivery, draft_ref: revised.draft_ref }, 'author:deliver-1')).rejects.toThrow('different draft');
    const delivered = await f.call('deliver_article', { draft_ref: revised.draft_ref, check_ref: revised.check_ref, declined_findings: [{ finding_id: 'f1', reason: 'Example is already covered by the requirements' }], judgment_summary: 'Deliver' }, 'author:deliver-2');
    expect(delivered.completion).toMatchObject({ status: 'waiting', outcome: 'submitted' });
    const row = f.sqlite.prepare('select versions_json, seo_contract_json from content_artifacts where id=?').get(delivered.output.artifact_id) as { versions_json: string; seo_contract_json: string };
    expect(JSON.parse(row.versions_json)[0].content).toBe(revisedBody);
    const contract = await readRuntimeJson<Record<string, any>>(f.db, row.seo_contract_json);
    expect(contract.self_check).toMatchObject({ summary: 'Ready to deliver', declined_findings: [{ finding_id: 'f1' }] });
    expect(contract).not.toHaveProperty('link_spots');
  });

  it('keeps a saved draft when the fresh check is unusable and rejects drafts from an earlier assignment', async () => {
    const f = await authorFixture();
    vi.mocked(isolatedReview).mockRejectedValueOnce(new ToolExecutionError('Review response is not valid JSON', { kind: 'invalid_output', retryable: false, effects: 'none', issues: [], guidance: 'Check again' }));
    const saved = (await f.call('save_article_draft', f.draft(oneLink), 'author:save-1')).output;
    expect(saved).toMatchObject({ accepted: true, check_ref: null, self_check: null, self_check_error: 'Review response is not valid JSON' });
    vi.mocked(isolatedReview).mockResolvedValueOnce({ summary: 'No issues', findings: [] });
    const rechecked = (await f.call('run_self_check', { draft_ref: saved.draft_ref, judgment_summary: 'Retry' }, 'author:check-1')).output;
    expect(rechecked).toMatchObject({ draft_ref: saved.draft_ref, check_ref: expect.any(String) });
    vi.mocked(isolatedReview).mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(f.call('run_self_check', { draft_ref: saved.draft_ref, judgment_summary: 'Retry' }, 'author:check-2')).rejects.toThrow('provider unavailable');

    f.sqlite.prepare('insert into agent_task_assignments(id,task_id,operation_id,context_json,created_at) values(?,?,?,?,?)').run('revision', 'author', 'revision', await persistRuntimeJson(f.db, f.article), 'now');
    f.sqlite.prepare("update agent_tasks set assignment_id='revision' where id='author'").run();
    await expect(f.call('deliver_article', { draft_ref: saved.draft_ref, check_ref: rechecked.check_ref, declined_findings: [], judgment_summary: 'Deliver' }, 'author:deliver'))
      .rejects.toThrow('earlier assignment');
  });
});

describe('reviewer link responsibility', () => {
  it('describes every internal link with its sentence and resolved target', async () => {
    const f = await contentLinkFixture();
    const content = 'Read the [reply checklist](article:old) first.\nThen [templates](article:sib) and [our tool](https://example.com/product).\n![diagram](https://example.com/product)\nSee [lost page](article:gone).';
    const links = await describeContentInternalLinks(f.db, { siteId: 's', policy: { blog_origin: 'https://blog.example.com', product_origin: 'https://example.com', hub_path: '/product', hub_urls: {} },
      versions: [{ locale: 'en', content }], siblings: [{ job_id: 'sib', title_direction: 'Reply templates', versions: [] }] });
    expect(links.map(link => [link.anchor_text, link.target.kind])).toEqual([['reply checklist', 'published'], ['templates', 'sibling'], ['our tool', 'product'], ['lost page', 'unavailable']]);
    expect(links[0]).toMatchObject({ sentence: 'Read the [reply checklist](article:old) first.', target: { title: 'Checklist', url: 'https://blog.example.com/en/blog/checklist-0' } });
    expect(links[1].target.title).toBe('Reply templates');
  });

  it('requires content and link judgments from reviewers from v10', async () => {
    const f = await editorialFixture();
    const r = await f.task('reviewer', 'content_review', { job_id: 'j', seo_contract: { editorial: { contract_version: 2 }, self_check: { contract_version: 1, summary: '', findings: [], declined_findings: [] } } });
    const run = f.sqlite.prepare('select * from agent_runs where id=?').get('reviewer');
    await runReviewConversation({ env: r.env, run, definition: agentDefinition('content_review') } as AgentModuleExecutionContext);
    const agent = vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent;
    expect(agent.instructions).toContain('Internal link review is your responsibility');
    expect(agent.instructions).not.toContain('internal_link_edit target snapshots');
    const submit = agent.tools().resolve(agentDefinition('content_review'), 'submit_content_review');
    expect(submit.version).toBe(3);
    const base = { decision: 'revise', value_assessment: 'Useful', seo_geo_risks: [], required_changes: ['Replace the checklist link'], judgment_summary: 'Revise', coverage_findings: [], evidence_findings: [],
      seo_strategy_assessment: 'Matches the primary intent', topic_requirement_assessment: 'Fulfills the topic promise', author_self_check_assessment: 'The rejection reason is valid' };
    expect(() => submit.inputSchema.parse(base)).toThrow();
    expect(submit.inputSchema.parse({ ...base, link_assessment: 'One link target mismatch', link_findings: [{ locale: 'en', anchor_text: 'reply checklist', target: 'Checklist', problem: 'The target is about pre-send checks, not how to write a reply', recommended_change: 'Change the link to the reply examples article' }] }))
      .toMatchObject({ link_findings: [{ anchor_text: 'reply checklist' }] });
  });
});

describe('earlier contracts under current definitions', () => {
  it('keeps direct submission for an author assigned without the author-owned link contract', async () => {
    const f = await editorialFixture();
    const a = await f.task('author', 'article_production', { editorial_contract_version: 2, coverage_plan: plan, job_id: 'j', locales: ['en'] });
    await runArticleConversation({ env: a.env, run: f.sqlite.prepare('select * from agent_runs where id=?').get('author'), definition: agentDefinition('article_production') } as AgentModuleExecutionContext);
    const agent = vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent;
    expect(agent.tools().names()).toContain('submit_article');
    expect(agent.tools().names()).not.toContain('save_article_draft');
    expect(agent.instructions).not.toContain('You own the internal links of this article');
  });

  it('reviews a candidate delivered without a fresh self-check under the prior review contract', async () => {
    const f = await editorialFixture();
    const r = await f.task('reviewer', 'content_review', { job_id: 'j', seo_contract: { editorial: { contract_version: 2 } } });
    await runReviewConversation({ env: r.env, run: f.sqlite.prepare('select * from agent_runs where id=?').get('reviewer'), definition: agentDefinition('content_review') } as AgentModuleExecutionContext);
    const agent = vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent;
    expect(agent.tools().resolve(agentDefinition('content_review'), 'submit_content_review').version).toBe(2);
    expect(agent.instructions).not.toContain('Internal link review is your responsibility');
  });
});
