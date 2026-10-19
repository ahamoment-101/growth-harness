import { describe, expect, it } from 'vitest';
import { contentLinkFixture } from './content-links.test-fixture';
import { applyContentLinkEdits, editArticleInternalLinksInput } from './content-link-editing';
import { contentLinkCounts, validateContentLinkLimit } from './content-link-policy';
import { readContentArticleTool, type ContentCandidate, type LinkTarget } from './content-link-reading';
import { readRuntimeJson } from './runtime-content';
import { applyContentReviewDecision, loadArticleProductionContext, persistArticleArtifact, type ArticleTask } from './content-production';
import type { AgentRun } from './protocol';
import { publicHref } from '../blog/seo';
import { beginTaskDecision, finishTaskOperation, requireTask, setTaskAction } from './task-store';

const policy = { blog_origin: 'https://blog.example.com', product_origin: 'https://example.com', hub_path: '/product', hub_urls: {} };
const body = '## Guide\n\nUse a checklist before sending your reply.\n\nKeep your message clear.';
const version = (content = body, locale = 'en') => ({ locale, slug: `guide-${locale}`, title: 'Reply guide', excerpt: 'A useful checklist', content });
const candidate: ContentCandidate = { id: 'draft', group_id: 'g', job_id: 'j', decision_item_id: 'item', child_run_id: 'author',
  attempt: 1, status: 'candidate', versions: [version()], seo_contract: {}, policy };
const target: LinkTarget = { job_id: 'old', locale: 'en', title: 'Checklist', content: 'Detailed checklist', href: 'article:old', status: 'published' };
const editArgs = (candidate_ref = 'candidate') => editArticleInternalLinksInput.parse({ candidate_ref,
  edits: [{ locale: 'en', original_text: 'Use a checklist before sending your reply.', replacement_text: 'Use a [checklist](article:old) before sending your reply.', target_refs: ['target'], reason: 'Detailed steps help here' }],
  judgment_summary: 'One relevant link is enough' });


describe('parent internal-link editing', () => {
  it('counts actual rendered body links including repeated and product links, excluding code, images and external citations', () => {
    const content = '[one](article:a) [two](/product) [three](https://blog.example.com/en/blog/a) [source](https://research.example.org/study) ![image](https://example.com/a.png) ` [code](article:b) `\n\n```\n[fenced](article:c)\n```';
    expect(contentLinkCounts([version(content)], policy)).toEqual([{ locale: 'en', internal_links: 3 }]);
    expect(() => validateContentLinkLimit([version(content + '\n[again](article:a)')], policy)).toThrow('limit');
    expect(() => validateContentLinkLimit([version('No related page is useful.')], policy)).not.toThrow();
    expect(contentLinkCounts([version('[external](https://example.com.evil.test/a) [relative](//example.com/product)')], policy)[0].internal_links).toBe(1);
  });

  it('preserves untouched prose, rejects ambiguous/overlapping edits and foreign-locale targets', () => {
    expect(applyContentLinkEdits(candidate, editArgs(), [target]).versions[0].content).toContain('Keep your message clear.');
    expect(() => applyContentLinkEdits({ ...candidate, versions: [version(body + '\n' + body)] }, editArgs(), [target])).toThrow('exactly once');
    const overlap = editArgs(); overlap.edits.push({ ...overlap.edits[0], original_text: 'checklist' });
    expect(() => applyContentLinkEdits(candidate, overlap, [target])).toThrow('overlap');
    expect(() => applyContentLinkEdits(candidate, editArgs(), [{ ...target, locale: 'pt' }])).toThrow('No selected target');
    const citation = { ...candidate, versions: [version(body + '\n[source](https://study.example.org)')] };
    const args = editArgs(); args.edits.push({ locale: 'en', original_text: '[source](https://study.example.org)', replacement_text: '', target_refs: [], reason: 'Remove' });
    expect(() => applyContentLinkEdits(citation, args, [target])).toThrow('external evidence');
  });

  it('requires evidence locations to match the edited candidate and supports exact location updates', () => {
    const c = structuredClone(candidate);
    c.seo_contract.editorial = { coverage_response: [{ locations: [{ locale: 'en', quote: 'Use a checklist before sending your reply.' }] }], claim_evidence: { claims: [] } };
    expect(() => applyContentLinkEdits(c, editArgs(), [target])).toThrow('Quoted passage');
    const args = editArgs(); args.location_updates = [{ locale: 'en', original_quote: args.edits[0].original_text, replacement_quote: args.edits[0].replacement_text }];
    expect(applyContentLinkEdits(c, args, [target]).counts[0].internal_links).toBe(1);
  });

  it('paginates immutable search and article snapshots without losing older matches or changing the observed body', async () => {
    const f = await contentLinkFixture();
    const next = await f.search.execute!(f.search.inputSchema.parse({ cursor: f.found.next_cursor, limit: 10, judgment_summary: 'Continue' }), f.context) as { articles: unknown[]; next_cursor: null };
    expect(next.articles).toHaveLength(6); expect(next.next_cursor).toBeNull();
    f.sqlite.prepare("update jobs set versions_json='[]' where id='old'").run();
    const rest = await f.search.execute!(f.search.inputSchema.parse({ article_ref: f.found.articles[0].article_ref, offset: f.targetRead.next_offset, judgment_summary: 'Read remainder' }), f.context) as { content: string; next_offset: null };
    expect(f.targetRead.content + rest.content).toBe('Detailed checklist '.repeat(900)); expect(rest.next_offset).toBeNull();
    await expect(f.edit.execute!(f.args, f.context)).rejects.toThrow('no longer live');
  });

  it('saves a new candidate once, keeps author provenance, and reviews only the edited version before publication approval', async () => {
    const f = await contentLinkFixture();
    const saved = await f.edit.execute!(f.args, f.context) as { artifact_id: string; candidate_ref: string };
    expect(await f.edit.execute!(f.args, f.context)).toMatchObject(saved);
    const rows = f.sqlite.prepare('select id,child_run_id,attempt,versions_json from content_artifacts order by attempt').all() as Array<{ id: string; child_run_id: string; attempt: number; versions_json: string }>;
    expect(rows).toHaveLength(2); expect(rows.map(r => r.child_run_id)).toEqual(['author', 'author']);
    expect(JSON.parse(rows[0].versions_json)[0].content).toBe(body);
    expect(JSON.parse(rows[1].versions_json)[0].content).toContain('[checklist](article:old)');
    expect(f.sqlite.prepare('select count(*) n from content_review_interactions').get()).toEqual({ n: 1 });
    const reviewer = await f.task('reviewer', 'content_review', { artifact_id: 'draft' });
    const pass = { decision: 'pass' as const, value_assessment: 'Useful', seo_geo_risks: [], required_changes: [], judgment_summary: 'Pass' };
    await expect(applyContentReviewDecision(reviewer.env.DB, 'reviewer', { group_id: 'g', job_id: 'j', artifact_id: 'draft' }, pass)).rejects.toThrow('changed after');
    f.sqlite.prepare('update agent_task_assignments set context_json=? where id=?').run(JSON.stringify({ artifact_id: saved.artifact_id }), 'reviewer');
    await applyContentReviewDecision(reviewer.env.DB, 'reviewer', { group_id: 'g', job_id: 'j', artifact_id: saved.artifact_id }, pass);
    expect(f.sqlite.prepare("select status,current_artifact_id,published_at from jobs where id='j'").get()).toEqual({ status: 'awaiting_review', current_artifact_id: saved.artifact_id, published_at: '' });
    const editedRow = f.sqlite.prepare('select seo_contract_json from content_artifacts where id=?').get(saved.artifact_id) as { seo_contract_json: string };
    expect(await readRuntimeJson(f.db, editedRow.seo_contract_json)).toMatchObject({ internal_link_edit: { targets: [{ job_id: 'old' }] } });
  });

  it('rejects stale observations, approval races, changed operation inputs and cancelled execution without overwriting work', async () => {
    const f = await contentLinkFixture();
    const saved = await f.edit.execute!(f.args, f.context) as { artifact_id: string };
    await expect(f.edit.execute!({ ...f.args, judgment_summary: 'Changed replay' }, f.context)).rejects.toThrow('binding changed');
    f.sqlite.prepare("delete from content_artifacts where id=?").run(saved.artifact_id);
    f.sqlite.prepare("update jobs set status='awaiting_review' where id='j'").run();
    await expect(f.edit.execute!(f.args, f.context)).rejects.toThrow('publication state changed');
    f.sqlite.prepare("update agent_tasks set status='cancelled' where id='parent'").run();
    await expect(f.edit.execute!(f.args, f.context)).rejects.toThrow();
    expect(f.sqlite.prepare('select count(*) n from content_artifacts').get()).toEqual({ n: 1 });
  });

  it('rejects another parent and out-of-task references', async () => {
    const f = await contentLinkFixture();
    const other = await f.task('other', 'content_production');
    await expect(readContentArticleTool(other.env, 'g').execute!(f.read.inputSchema.parse({ candidate_ref: f.observed.candidate_ref, judgment_summary: 'Read' }), other.context)).rejects.toThrow('does not own');
    await expect(f.read.execute!(f.read.inputSchema.parse({ candidate_ref: 'invented', judgment_summary: 'Read' }), f.context)).rejects.toThrow('Unknown');
  });

  it('does not reinterpret a second edit against a newer candidate', async () => {
    const f = await contentLinkFixture();
    const saved = await f.edit.execute!(f.args, f.context) as { artifact_id: string };
    await finishTaskOperation(f.p.env.DB, f.p.task, f.op, saved);
    const task = await requireTask(f.p.env.DB, 'parent');
    const operation = await beginTaskDecision(f.p.env.DB, task, {});
    await setTaskAction(f.p.env.DB, task, operation, { name: 'edit_article_internal_links', input: f.args });
    await expect(f.edit.execute!(f.args, { ...f.context, idempotencyKey: operation.id })).rejects.toThrow('Candidate or publication state changed');
    expect(f.sqlite.prepare('select id from content_artifacts order by attempt desc limit 1').get()).toEqual({ id: saved.artifact_id });
    expect(f.sqlite.prepare('select count(*) n from content_artifacts').get()).toEqual({ n: 2 });
  });

  it('keeps parent links and their target observations through an author revision', async () => {
    const f = await contentLinkFixture();
    const saved = await f.edit.execute!(f.args, f.context) as { artifact_id: string };
    const row = f.sqlite.prepare('select versions_json,seo_contract_json from content_artifacts where id=?').get(saved.artifact_id) as { versions_json: string; seo_contract_json: string };
    const versions = JSON.parse(row.versions_json);
    const seo = await readRuntimeJson<Record<string, unknown>>(f.db, row.seo_contract_json);
    for (let i = 0; i < 45; i++) f.sqlite.prepare("insert into jobs(id,production_group_id,status,versions_json,published_at) values(?,'','published',?,'2026-09-14')")
      .run(`recent-${i}`, JSON.stringify([version('Newer unrelated post')]));
    const site = f.sqlite.prepare("select * from sites where id='s'").get() as Record<string, unknown>;
    const [source] = await loadArticleProductionContext(f.p.env.DB, site, { id: 'author', workspace_id: 'w', site_id: 's',
      summary_json: JSON.stringify({ group_id: 'g', job_id: 'j', attempt: 3 }) } as AgentRun);
    const task = source.value as ArticleTask;
    expect(task.previous_candidate).toEqual({ artifact_id: saved.artifact_id, versions, seo_contract: seo });
    expect(task.published_articles).toContainEqual({ job_id: 'old', locale: 'en', title: 'Checklist', url: 'https://blog.example.com/en/blog/checklist-0' });
    const author = await f.task('author', 'article_production', task);
    versions[0].content += '\n\nA clarified final step.';
    const revised = await persistArticleArtifact(author.env, 'author', task, { versions, seo_contract: {} } as never, 'revision');
    const result = f.sqlite.prepare('select versions_json,seo_contract_json,supersedes_artifact_id from content_artifacts where id=?').get(revised.artifactId) as { versions_json: string; seo_contract_json: string; supersedes_artifact_id: string };
    expect(result.supersedes_artifact_id).toBe(saved.artifact_id);
    expect(JSON.parse(result.versions_json)[0].content).toContain('[checklist](article:old)');
    expect(await readRuntimeJson(f.db, result.seo_contract_json)).toMatchObject({ internal_link_targets: [{ job_id: 'old' }] });
    expect(publicHref('article:old', { articleUrlsByJob: { old: 'https://blog.example.com/en/blog/checklist-0' } } as never)).toContain('/checklist-0');
    expect(publicHref('article:pending', { articleUrlsByJob: {} } as never)).toBe('');
  });
});
