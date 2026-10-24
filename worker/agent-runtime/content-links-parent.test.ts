// These tests isolate editorial/domain contracts; learning orchestration has its own Runtime acceptance.
vi.mock('../learning/business', async () => { const runtime = await import('./conversation-runtime'); return { runBusinessConversationTask: runtime.runConversationTask }; });
import { expect, it, vi } from 'vitest';
import { contentLinkFixture } from './content-links.test-fixture';
import { runContentParentConversation } from './content-parent-conversation';
import { runConversationTask } from './conversation-runtime';
import { agentDefinition } from './definitions';
import { saveSlot } from './parameter-slots';
import { beginTaskDecision, finishTaskOperation, requireTask, setTaskAction } from './task-store';
import type { AgentModuleExecutionContext } from './agent-modules';
import type { AgentRun } from './protocol';
import { AUTHOR_CONTENT_LINK_REQUIREMENT_INSTRUCTIONS } from './content-link-policy';

vi.mock('./conversation-runtime', () => ({ runConversationTask: vi.fn(async () => ({ status: 'waiting', output: {} })) }));
vi.mock('./child-run-wait', () => ({ waitForChildRuns: async () => [] }));

it('maps parent read/edit tools and dispatches the exact edited candidate and target evidence to isolated review', async () => {
  const f = await contentLinkFixture();
  const run = f.sqlite.prepare("select * from agent_runs where id='parent'").get() as AgentRun;
  run.definition_version = 19; run.summary_json = JSON.stringify({ group_id: 'g' });
  const startChildRun = vi.fn(async (value: {runId: string}) => ({ id: value.runId }));
  await runContentParentConversation({ env: f.p.env, run, definition: agentDefinition('content_production'), startChildRun, step: {} } as unknown as AgentModuleExecutionContext);
  const agent = vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent;
  expect(agent.instructions).toContain('Zero is valid');
  expect(agent.instructions).not.toContain(AUTHOR_CONTENT_LINK_REQUIREMENT_INSTRUCTIONS);
  expect(await agent.context(f.p.task)).not.toHaveProperty('internal_linking');
  const registry = agent.tools(f.p.task, f.op);
  expect(registry.resolve(agentDefinition('content_production'), 'read_published_articles').version).toBe(2);
  const edit = registry.resolve(agentDefinition('content_production'), 'edit_article_internal_links');
  const saved = await edit.execute!(f.args, f.context) as {artifact_id: string};
  await finishTaskOperation(f.p.env.DB, f.p.task, f.op, saved);
  const task = await requireTask(f.p.env.DB, 'parent');
  const observation_ref = await saveSlot(f.p.env.DB, task, 'content_group', { group: {id: 'g'}, items: [{ job_id: 'j', decision_item_id: 'item', artifact_id: saved.artifact_id, artifact_status: 'candidate', job_status: 'drafting', attempt: 2, parent_review: {}, review_note: '' }] });
  const operation = await beginTaskDecision(f.p.env.DB, task, {});
  const args = { observation_ref, job_ids: ['j'], judgment_summary: 'One useful link; review final draft' };
  await setTaskAction(f.p.env.DB, task, operation, {name: 'start_content_reviews', input: args});
  const review = agent.tools(task, operation).resolve(agentDefinition('content_production'), 'start_content_reviews');
  await review.execute!(args, { ...f.context, idempotencyKey: operation.id });
  expect(startChildRun).toHaveBeenCalledOnce();
  expect(startChildRun.mock.calls[0][0]).toMatchObject({ initialAssignment: { material: { artifact_id: saved.artifact_id,
    author_child_run_id: 'author', internal_linking_contract: 1,
    versions: [{locale: 'en', content: expect.stringContaining('[checklist](article:old)')}],
    seo_contract: { internal_link_edit: { targets: [{job_id: 'old'}] } },
  } } });
});

it('blocks review of an over-limit candidate even when the parent skips editing, and retains old parent tool contracts', async () => {
  const f = await contentLinkFixture();
  const run = f.sqlite.prepare("select * from agent_runs where id='parent'").get() as AgentRun;
  run.definition_version = 19; run.summary_json = JSON.stringify({ group_id: 'g' });
  const startChildRun = vi.fn();
  await runContentParentConversation({env:f.p.env,run,definition:agentDefinition('content_production'),startChildRun,step:{}} as unknown as AgentModuleExecutionContext);
  const agent = vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent;
  f.sqlite.prepare("update content_artifacts set versions_json=? where id='draft'").run(JSON.stringify([{locale:'en',content:'[a](article:a) [b](article:b) [c](article:c) [d](article:d)'}]));
  const observation_ref = await saveSlot(f.p.env.DB, f.p.task, 'content_group', {group:{id:'g'},items:[{job_id:'j',decision_item_id:'item',artifact_id:'draft',artifact_status:'candidate',job_status:'drafting',attempt:1,parent_review:{},review_note:''}]});
  const tool=agent.tools(f.p.task,f.op).resolve(agentDefinition('content_production'),'start_content_reviews');
  await expect(tool.execute!({observation_ref,job_ids:['j'],judgment_summary:'Review'},f.context)).rejects.toThrow('internal-link limit');
  expect(startChildRun).not.toHaveBeenCalled();
  run.definition_version=18;
  await runContentParentConversation({env:f.p.env,run,definition:agentDefinition('content_production'),startChildRun,step:{}} as unknown as AgentModuleExecutionContext);
  const legacy=vi.mocked(runConversationTask).mock.calls.at(-1)![0];
  expect(legacy.definition.tools).not.toContain('edit_article_internal_links');
  expect(legacy.agent.tools().names()).not.toContain('read_published_articles');
});
