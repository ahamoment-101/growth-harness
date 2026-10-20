// Opt-in synthetic checks against the configured production model adapters.
// No remote database writes or article publication.
import { localConfiguration } from '../../scripts/configuration';
import { expect, it } from 'vitest';
import { runAgentLoopContinue, type AgentContext } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { conversationChannel } from './conversation-channel';
import { conversationTool } from './conversation-tools';
import { type AgentId } from './definitions';
import { resolveModelProfile } from './model-registry';
import { coveragePlanInput, evidenceLedgerInput } from './content-editorial';
import { submitEditorialReviewInputSchema } from './content-review-tools';
import { submitEditorialArticleInputSchema } from './article-production-tools';
import { contentEditorialWritingSelection } from './content-parent-conversation';
import type { z } from 'zod';
const enabled = process.env.CONTENT_EDITORIAL_LIVE_VERIFY === '1';
const cases: Array<{ agent: AgentId; name: string; schema: z.ZodType; prompt: string; verify: (input: any) => void }> = [
  { agent:'content_production',name:'save_coverage_plan',schema:coveragePlanInput,
    prompt:'Synthetic protocol test. Save a plan with observation_ref=observed-job, job_id=synthetic-job. The reader wants to reply to an email. Include one core question about the next step, mark basis hypothesis and use no evidence_refs. Omit previous_plan_ref and requirement IDs because this is a new plan.',
    verify: value => { expect(value.job_id).toBe('synthetic-job');expect(value.requirements.length).toBeGreaterThan(0);expect(value.requirements[0].basis).toBe('hypothesis'); } },
  { agent:'article_production',name:'save_claim_evidence',schema:evidenceLedgerInput,
    prompt:'Synthetic protocol test. Save a ledger for one claim: The experiment found improved delayed test performance. Its source_id=synthetic-study, exact quote=Delayed test scores improved. relation=supports. The experiment does not test English email writing. Include that limitation; use no locations because no draft exists yet. Do not infer real product efficacy. Omit previous_ledger_ref and claim ID for creation.',
    verify: value => { expect(value.claims).toHaveLength(1);expect(value.claims[0].sources[0]).toMatchObject({source_id:'synthetic-study',quote:'Delayed test scores improved.'});expect(value.claims[0].limitations.length).toBeGreaterThan(0); } },
  { agent:'content_production',name:'start_article_tasks',schema:contentEditorialWritingSelection,
    prompt:'Synthetic contract test. Assign the only job synthetic-job using observation_ref=observed-job and its saved coverage_ref=saved-plan. Include editorial_brief asking for a worked email reply. Select exactly that plan in coverage_plans. Do not invent identities.',
    verify:value=>{expect(value.coverage_plans).toEqual([{job_id:'synthetic-job',coverage_ref:'saved-plan'}]);} },
  { agent:'article_production',name:'submit_article',schema:submitEditorialArticleInputSchema,
    prompt:'Synthetic contract test. Submit one en article version (slug reply-guide, title Reply guide) explaining how to reply to an email with a next step. Include excerpt and Markdown content. Select ledger_ref=saved-ledger and provide coverage_response for requirement_id=reply-example, status answered, explanation and one exact quote from the content as its en location. Fill the SEO contract to describe the actual draft. No external factual claims or sources are needed for this illustrative example.',
    verify:value=>{expect(value.bundle.ledger_ref).toBe('saved-ledger');expect(value.bundle.coverage_response[0].requirement_id).toBe('reply-example');expect(value.bundle.versions[0].content).toContain(value.bundle.coverage_response[0].locations[0].quote);} },
  { agent:'content_review',name:'submit_content_review',schema:submitEditorialReviewInputSchema,
    prompt:'Review this synthetic locked candidate. Coverage requirement id=reply-example asks for a worked email reply, but none exists. Candidate en text: "This experiment proves the product guarantees perfect English emails." Registered claim id=claim-1 matches that sentence. Saved source synthetic-study says only "Delayed test scores improved." in a lab memory experiment and does not test the product or email writing. Submit concrete coverage_findings and evidence_findings, including the unsupported extrapolation and missing example. You may leave locations empty for missing material. Do not invent evidence.',
    verify: value => { expect(value.decision).toBe('revise');expect(value.coverage_findings.some((f:any)=>f.requirement_id==='reply-example')).toBe(true);expect(value.evidence_findings.some((f:any)=>f.claim_id==='claim-1')).toBe(true);expect(value.required_changes.length).toBeGreaterThan(0); } },
];
for (const test of cases) it.skipIf(!enabled)(`serializes ${test.agent} editorial contract and preserves evidence boundaries on the real endpoint`, async () => {
  const { env: vars } = localConfiguration();
  const requests: Array<Record<string,any>>=[];
  const channel=conversationChannel({...resolveModelProfile(vars,test.agent),maxOutputTokens:4096}, async(url,init)=>{
    if(requests.length>=4)throw new Error('Synthetic probe request budget exhausted');
    requests.push(JSON.parse(String(init?.body)));return fetch(url,init);
  });
  let calls=0;const proof=crypto.randomUUID();
  const context:AgentContext={systemPrompt:test.prompt+' Call the supplied tool once, then return its receipt proof.',messages:[{role:'user',content:'Perform the synthetic check now.',timestamp:Date.now()}],
    tools:[conversationTool({name:test.name,description:'Save the synthetic editorial result and return a proof.',inputSchema:test.schema},async(_id,input)=>{
      test.verify(test.schema.parse(input));calls++;return {content:[{type:'text',text:JSON.stringify({proof})}],details:{proof}};
    })]};
  await runAgentLoopContinue(context,{model:channel.model,maxTokens:4096,convertToLlm:messages=>messages as Message[],beforeToolCall:async()=>calls>=1?{block:true,terminate:true,reason:'Synthetic operation already completed'}:undefined},async event=>{ if(event.type==='message_end' && event.message.role==='assistant' && event.message.errorMessage) throw new Error(event.message.errorMessage); },AbortSignal.timeout(90000),channel.stream);
  expect(calls).toBe(1);expect(requests[0].tools[0].function.parameters.type).toBe('object');
  expect(requests.some(r=>r.messages.some((m:any)=>m.role==='tool'&&String(m.content).includes(proof)))).toBe(true);
  console.info('EDITORIAL_LIVE',JSON.stringify({agent:test.agent,model:channel.model.id,requests:requests.length,tool:test.name,valid:true}));
},100000);

it.skipIf(!enabled)('acquires a real public page through accounted source reading and reuses its saved snapshot', async () => {
  const { editorialFixture } = await import('./content-editorial.test-fixture');
  const { contentSourceTool } = await import('./content-editorial');
  const f = await editorialFixture();
  const a = await f.task('source-probe', 'article_production');
  const { env: vars } = localConfiguration();
  const tool = contentSourceTool({ ...a.env, FIRECRAWL_API_KEY: vars.FIRECRAWL_API_KEY });
  const result = await tool.execute!(tool.inputSchema.parse({ url: 'https://example.com', purpose: 'Synthetic evidence acquisition smoke' }), a.context) as { source_id: string; excerpt: string; captured_at: string };
  expect(result.excerpt).toContain('Example Domain');
  expect(result.captured_at).toBeTruthy();
  const saved = await tool.execute!(tool.inputSchema.parse({ source_id: result.source_id, purpose: 'Read the same saved evidence' }), a.context);
  expect(saved).toEqual(result);
  expect(f.sqlite.prepare('select count(*) n from agent_task_external_usage').get()).toEqual({ n: 1 });
  console.info('EDITORIAL_SOURCE_LIVE', JSON.stringify({ url: 'https://example.com', snapshotSaved: true, accountedRequests: 1 }));
}, 70000);
