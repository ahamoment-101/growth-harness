import { expect, it, vi } from 'vitest';
import { editorialFixture } from './content-editorial.test-fixture';
import { runArticleConversation, runReviewConversation } from './content-conversations';
import { runConversationTask } from './conversation-runtime';
import { agentDefinition } from './definitions';
import { saveSlot } from './parameter-slots';
import { readRuntimeJson, persistRuntimeJson } from './runtime-content';
import { type ArticleTask, type ContentReviewTask, articleVersionsForContentReview } from './content-production';
import type { AgentModuleExecutionContext } from './agent-modules';
import type { CoveragePlan, EditorialCandidate } from './content-editorial';

// Drive the concrete business tool executors without an LLM. Runtime fencing,
// SQLite persistence and exact-candidate checks are real; transport is tested separately.
vi.mock('./conversation-runtime', () => ({ runConversationTask: vi.fn(async () => ({status:'waiting',output:{}})) }));
const plan: CoveragePlan={job_id:'j',revision:1,previous_plan_ref:'',reader_task:'Write a reply',distinct_value:'Example',requirements:[{id:'question',question:'How?',importance:'core',reason:'User task',basis:'hypothesis',evidence_refs:[],page_scope:'this_page'}]};

it('persists candidate evidence and full review findings, rejects invented passages and an old candidate, and retains legacy tools', async () => {
  const f=await editorialFixture();
  f.sqlite.exec(`
    alter table content_production_groups add column status text default 'reviewing';
    alter table content_production_groups add column ready_items integer default 0;
    alter table content_production_groups add column failed_items integer default 0;
    alter table content_production_groups add column review_round integer default 0;
    alter table content_production_groups add column review_json text default '{}';
    alter table content_production_groups add column error text default '';
    alter table content_production_groups add column updated_at text default '';
    alter table jobs add column status text default 'drafting';
    alter table jobs add column child_run_id text default '';
    alter table jobs add column error text default '';
    alter table jobs add column review_note text default '';
    alter table jobs add column updated_at text default '';
    alter table jobs add column content_updated_at text default '';
    alter table jobs add column current_artifact_id text default '';
    alter table jobs add column versions_json text default '[]';
    alter table jobs add column qa_report text default '{}';
    create table content_artifacts(id text primary key,group_id text,job_id text,decision_item_id text,child_run_id text,submission_operation_id text unique,attempt integer,status text,versions_json text,seo_contract_json text,qa_report_json text,parent_review_json text,supersedes_artifact_id text,created_at text,updated_at text);
    create table content_review_interactions(id text primary key,idempotency_key text unique,group_id text,job_id text,artifact_id text,parent_run_id text,child_run_id text,kind text,actor_type text,actor_id text,summary text,payload_json text,created_at text);
  `);
  const article: ArticleTask={editorial_contract_version:2,coverage_plan:plan,group_id:'g',job_id:'j',decision_group_id:'decision',decision_item_id:'item',source_locale:'en',locales:['en'],hub_path:'/',hub_urls:{},product_origin:'',blog_origin:'',published_articles:[],group_articles:[],topic:{},group:{},business_context:[],strategy_context:[],evidence:[],attempt:1,parent_feedback:[],previous_artifact_id:''};
  const a=await f.task('author','article_production',article);
  // Direct submission is the pinned v16 author contract; v17 saves, checks and delivers (content-self-check-flow.test.ts).
  f.sqlite.prepare('update agent_runs set definition_version=16 where id=?').run('author');
  const run=f.sqlite.prepare('select * from agent_runs where id=?').get('author');
  await runArticleConversation({env:a.env,run,definition:agentDefinition('article_production')} as AgentModuleExecutionContext);
  const authorAgent=vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent;
  const registry=authorAgent.tools();const submit=registry.resolve(agentDefinition('article_production'),'submit_article');
  const ledger={job_id:'j',revision:1,previous_ledger_ref:'',claims:[]};
  const ledger_ref=await saveSlot(a.env.DB,a.task,'content_evidence',ledger);
  const versions=[{locale:'en',slug:'reply-guide',title:'Reply guide',excerpt:'Write a reply',content:'## Reply\n\nState the next step clearly.'}];
  const args={bundle:{versions,ledger_ref,coverage_response:[{requirement_id:'question',status:'answered',explanation:'An actionable example',locations:[{locale:'en',quote:'State the next step clearly.'}]}],seo_contract:{search_intent:'Write a reply',reader_value:'An example',direct_answer:'State the next step clearly.',primary_keyword:'reply',supporting_terms:[],geo_summary:'Reply guidance'}},judgment_summary:'Candidate'};
  await expect(submit.execute!({...args,bundle:{...args.bundle,coverage_response:[{...args.bundle.coverage_response[0],locations:[{locale:'en',quote:'Fabricated passage'}]}]}},a.context)).rejects.toThrow('does not occur');
  const saved=await submit.execute!(submit.inputSchema.parse(args),a.context) as {artifact_id:string};
  expect(await submit.execute!(submit.inputSchema.parse(args),a.context)).toEqual(saved);
  const row=f.sqlite.prepare('select * from content_artifacts where id=?').get(saved.artifact_id) as Record<string,string>;
  const seo=await readRuntimeJson<{editorial:EditorialCandidate}>(f.db,row.seo_contract_json);
  expect(seo.editorial.coverage_plan).toEqual(plan);
  expect(seo).not.toHaveProperty('factual_claims');
  const review={group_id:'g',job_id:'j',artifact_id:saved.artifact_id,author_child_run_id:'author',parent_run_id:'',attempt:1,seo_contract:seo,versions:articleVersionsForContentReview(versions)} as unknown as ContentReviewTask;
  const r=await f.task('reviewer','content_review',review);
  f.sqlite.prepare('update agent_runs set definition_version=9 where id=?').run('reviewer');
  const rr=f.sqlite.prepare('select * from agent_runs where id=?').get('reviewer');
  await runReviewConversation({env:r.env,run:rr,definition:agentDefinition('content_review')} as AgentModuleExecutionContext);
  const reviewer=vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent.tools();
  expect(reviewer.resolve(agentDefinition('content_review'),'read_article_source').completion).toBeUndefined();
  const reviewTool=reviewer.resolve(agentDefinition('content_review'),'submit_content_review');
  const decision={decision:'revise',value_assessment:'Missing a worked example',seo_geo_risks:[],required_changes:['Add the example'],judgment_summary:'Targeted revision',coverage_findings:[{requirement_id:'question',assessment:'partial',locations:[],explanation:'Observed gap. '.repeat(6000),recommended_change:'Add a concrete reply'}],evidence_findings:[{claim_id:'',claim:'An unregistered empirical claim',source_ids:[],locations:[],assessment:'needs_evidence',explanation:'Independently identified',recommended_change:'Qualify or support'}]};
  const result=await reviewTool.execute!(reviewTool.inputSchema.parse(decision),r.context);
  expect(result).toMatchObject({decision:'revise'});
  const stored=f.sqlite.prepare('select parent_review_json from content_artifacts where id=?').get(saved.artifact_id) as {parent_review_json:string};
  expect(stored.parent_review_json.length).toBeLessThan(1000);
  expect(await readRuntimeJson(f.db,stored.parent_review_json)).toEqual({ ...reviewTool.inputSchema.parse(decision) as object, review_run_id: 'reviewer' });
  // Another candidate cannot be reviewed using the old assignment.
  f.sqlite.prepare("update content_artifacts set status='candidate' where id=?").run(saved.artifact_id);
  f.sqlite.prepare(`insert into content_artifacts select 'newer',group_id,job_id,decision_item_id,child_run_id,'next-operation',2,'candidate',versions_json,seo_contract_json,qa_report_json,'{}',id,created_at,updated_at from content_artifacts where id=?`).run(saved.artifact_id);
  await expect(reviewTool.execute!(reviewTool.inputSchema.parse({...decision,decision:'pass',required_changes:[]}),r.context)).rejects.toThrow('changed after');
  expect(f.sqlite.prepare("select count(*) n from content_artifacts").get()).toEqual({n:2});
  // Existing author assignment keeps the v1 tool contract without new required inputs.
  await f.db.prepare('update agent_task_assignments set context_json=? where id=?').bind(await persistRuntimeJson(f.db,{...article,editorial_contract_version:1}),'author').run();
  await runArticleConversation({env:a.env,run,definition:agentDefinition('article_production')} as AgentModuleExecutionContext);
  const legacy=vi.mocked(runConversationTask).mock.calls.at(-1)![0].agent.tools();
  expect(legacy.names()).not.toContain('save_claim_evidence');
  expect(legacy.resolve(agentDefinition('article_production'),'submit_article').version).toBe(1);
});
