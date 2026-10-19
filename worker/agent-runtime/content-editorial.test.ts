import { editorialFixture } from './content-editorial.test-fixture';
import { describe, expect, it, vi } from 'vitest';
import { persistRuntimeJson } from './runtime-content';
import { saveSlot, resolveSlot } from './parameter-slots';
import { saveSource } from '../lib/research/evidence';
import { readWebPage } from '../lib/research/browser';
import { coveragePlanTool, evidenceLedgerTool, contentSourceTool, readContentSource, validateCoverageResponses,
  validateEditorialLocations, type CoveragePlan, type EvidenceLedger } from './content-editorial';

vi.mock('../lib/research/browser', async importOriginal => ({ ...await importOriginal<typeof import('../lib/research/browser')>(), readWebPage: vi.fn() }));


describe('content editorial receipts', () => {
  it('identifies every invalid quote and its originating ledger while preserving valid locations', () => {
    try {
      validateEditorialLocations([{ locale: 'en', content: 'Current wording is retained.' }], [
        { locale: 'en', quote: 'Current wording' },
        { locale: 'en', quote: 'Outdated first claim' },
        { locale: 'en', quote: 'Outdated second claim' },
      ], 'evidence ledger observed-ref');
      throw new Error('Expected quote validation failure');
    } catch (error) {
      expect(error).toMatchObject({ details: {
        effects: 'none',
        issues: [
          { path: ['evidence ledger observed-ref', 1, 'quote'], message: expect.stringContaining('Outdated first claim') },
          { path: ['evidence ledger observed-ref', 2, 'quote'], message: expect.stringContaining('Outdated second claim') },
        ],
        guidance: expect.stringContaining('observed-ref'),
      } });
    }
  });

  it('creates immutable plans, replays IDs, preserves revisions and rejects cross-job references and stale execution', async () => {
    const f=await editorialFixture(); const p=await f.task('parent','content_production');
    const observation_ref=await saveSlot(p.env.DB,p.task,'content_group',{group:{id:'g'},items:[{job_id:'j'}]});
    const tool=coveragePlanTool(p.env,'g');
    const input={observation_ref,job_id:'j',reader_task:'Write a reply',distinct_value:'Worked example',requirements:[{question:'How to reply?',importance:'core' as const,reason:'Main task',basis:'hypothesis' as const,evidence_refs:[],page_scope:'this_page' as const}],judgment_summary:'Plan'};
    const first=await tool.execute!(input,p.context) as {coverage_ref:string;plan:CoveragePlan};
    expect(await tool.execute!(input,p.context)).toEqual(first);
    const second=await tool.execute!({...input,previous_plan_ref:first.coverage_ref,requirements:[{...first.plan.requirements[0],page_scope:'related_page'}]}, {...p.context,idempotencyKey:'revision'}) as typeof first;
    expect(second.plan.requirements[0].id).toBe(first.plan.requirements[0].id);
    expect((await resolveSlot<CoveragePlan>(p.env.DB,p.task,first.coverage_ref,'content_coverage')).requirements[0].page_scope).toBe('this_page');
    expect(()=>validateCoverageResponses(second.plan,[{requirement_id:second.plan.requirements[0].id,status:'move_to_related_page',explanation:'Separate task',locations:[]}])).not.toThrow();
    await expect(tool.execute!({...input,requirements:[{...input.requirements[0],id:'invented'}]},p.context)).rejects.toThrow('Unknown previous');
    await expect(tool.execute!({...input,job_id:'foreign'},p.context)).rejects.toThrow('outside');
    f.sqlite.prepare("update agent_tasks set status='cancelled' where id='parent'").run();
    await expect(tool.execute!(input,p.context)).rejects.toThrow();
  });

  it('checks exact source quotes, paginates snapshots, preserves a ledger across failures and grants only assigned reviewer sources', async () => {
    const f=await editorialFixture(); const a=await f.task('author','article_production');
    const body='# Study\n'+ 'Long source text. '.repeat(1100)+'Retrieval improved delayed testing under these conditions.';
    const source=await saveSource(a.env,a.task,'https://example.com/study',body);
    const tool=evidenceLedgerTool(a.env);
    const claim={claim:'Retrieval improved testing',assessment:'partial' as const,supported_scope:'These conditions only',limitations:'Not an English-writing outcome',locations:[{locale:'en',quote:'Retrieval improved testing'}],sources:[{source_id:source.id,quote:'Retrieval improved delayed testing under these conditions.',relation:'supports' as const}]};
    const input={claims:[claim],judgment_summary:'Save qualified claim'};
    const saved=await tool.execute!(input,a.context) as {ledger_ref:string;ledger:EvidenceLedger};
    expect(await tool.execute!(input,a.context)).toEqual(saved);
    await expect(tool.execute!({...input,claims:[{...claim,sources:[{...claim.sources[0],quote:'It is the best method for everyone.'}]}]}, {...a.context,idempotencyKey:'bad'})).rejects.toThrow('absent');
    expect(await resolveSlot(a.env.DB,a.task,saved.ledger_ref,'content_evidence')).toEqual(saved.ledger);
    const reader=contentSourceTool(a.env);
    const first=await reader.execute!({source_id:source.id,offset:0,purpose:'Read'},a.context) as {excerpt:string;next_offset:number};
    const rest=await reader.execute!({source_id:source.id,offset:first.next_offset,purpose:'Read rest'},a.context) as {excerpt:string};
    expect(first.excerpt+rest.excerpt).toBe(body);
    const r=await f.task('reviewer','content_review',{artifact_id:'candidate',author_child_run_id:'author',seo_contract:{editorial:{claim_evidence:saved.ledger}}});
    expect((await readContentSource(r.env,r.task,source.id)).content).toBe(body);
    const other=await saveSource(a.env,a.task,'https://example.com/private-source','Unassigned source');
    await expect(readContentSource(r.env,r.task,other.id)).rejects.toThrow('not supplied');
    const reviewSource=await saveSource(r.env,r.task,'https://example.com/new-study','Reviewer found a useful limitation.');
    await f.db.prepare('update agent_task_assignments set context_json=? where id=?').bind(await persistRuntimeJson(f.db,{job_id:'j',editorial_feedback:{review_run_id:'reviewer',coverage_findings:[],evidence_findings:[{source_ids:[reviewSource.id]}]}}),'author').run();
    expect((await readContentSource(a.env,a.task,reviewSource.id)).content).toBe('Reviewer found a useful limitation.');
    const stranger=await f.task('stranger','article_production');
    await expect(readContentSource(stranger.env,stranger.task,source.id)).rejects.toThrow('outside');
    vi.mocked(readWebPage).mockRejectedValueOnce(new Error('HTTP 429'));
    await expect(reader.execute!({url:'https://example.com/unavailable',offset:0,purpose:'Research'},a.context)).rejects.toThrow('429');
    expect(await resolveSlot(a.env.DB,a.task,saved.ledger_ref,'content_evidence')).toEqual(saved.ledger);
    expect(()=>validateEditorialLocations([{locale:'en',content:'Retrieval improved testing'}],claim.locations)).not.toThrow();
    expect(()=>validateEditorialLocations([{locale:'pt-BR',content:'Different text'}],claim.locations)).toThrow('does not occur');
  });

  it('allows an empty or uncertain ledger and preserves large evidence without truncation', async () => {
    const f=await editorialFixture(); const a=await f.task('author','article_production'); const tool=evidenceLedgerTool(a.env);
    const empty=await tool.execute!({claims:[],judgment_summary:'No factual claims'},a.context) as {ledger_ref:string};
    const result=await tool.execute!({previous_ledger_ref:empty.ledger_ref,claims:[{claim:'Uncertain claim',assessment:'unverified',supported_scope:'Unknown',limitations:'Pending confirmation 🙂'.repeat(15000),sources:[],locations:[]}],judgment_summary:'Keep uncertainty'}, {...a.context,idempotencyKey:'large'}) as {ledger_ref:string;ledger:EvidenceLedger};
    expect(await resolveSlot(a.env.DB,a.task,result.ledger_ref,'content_evidence')).toEqual(result.ledger);
    expect(()=>validateCoverageResponses({requirements:[{id:'one'}]} as CoveragePlan,[])).toThrow('each assigned');
  });
});
