import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { taskTestDb } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, taskForRun } from './task-store';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution, ExecutionHandoff } from './runtime-executions';
import { executionStep } from './execution-step';
import { executionEnvironment } from './execution-context';
import { runConversationTask } from './conversation-runtime';
import { ToolRegistry } from './tools';
import { replayConversationResponse } from './conversation-replay';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';

const model: Model<'openai-completions'> = { id: 'test', name: 'test', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 1000000, maxTokens: 100, cost: {input:0,output:0,cacheRead:0,cacheWrite:0} };
const step = { do: async (_key:string, config:unknown, fn?:()=>Promise<unknown>) => (fn || config as ()=>Promise<unknown>)() } as RuntimeWorkflowStep;
function reply(calls: Array<{id:string;name:string;arguments:Record<string,unknown>}>): AssistantMessage {
  return { role:'assistant', content:calls.map(call=>({type:'toolCall',...call})), api:model.api, provider:model.provider, model:model.id, stopReason:'toolUse', timestamp:1,
    usage:{input:10,output:10,totalTokens:20,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
}
async function fixture(name='save_fact') {
  const state = taskTestDb();
  const definition = { ...agentDefinition('strategy_research'), tools:[name,'finish'], stagePolicy:undefined,
    runPolicy:{...agentDefinition('strategy_research').runPolicy,maxDecisionTurns:2,maxModelCalls:2,maxTotalTokens:100} };
  const task = await attachTask(state.db,state.run(),definition);
  const execution = await createRuntimeExecution(state.db,task.active_run_id);
  await activateRuntimeExecution(state.db,authorityForExecution(execution),execution.workflow_id);
  const env = executionEnvironment({DB:state.db} as RuntimeAgentEnv,authorityForExecution(execution));
  const effects:string[]=[];
  const observations:string[]=[];
  const responses:AssistantMessage[]=[];
  const stream:StreamFn=(model,context,options)=>{
    observations.push(JSON.stringify(context));
    const value=responses.shift(); if(!value) throw new Error('No synthetic response');
    return replayConversationResponse(value,stream)(model,context,options);
  };
  const agent = { instructions:'Complete the assigned business work', context:async()=>({goal:'Preserve the original business constraint'}), completionInstructions:'Use finish when done.',
    tools:()=>new ToolRegistry().register({name,version:1,capability:'write',approval:'never',timeoutMs:1000,retryable:false,replaySafety:'idempotent',inputSchema:z.object({value:z.string()}),outputSchema:z.unknown(),description:'Save the selected business value',execute:async(args,context)=>{
      await env.DB.prepare("update agent_tasks set reason=? where active_run_id=?").bind(args.value,context.runId).run(); effects.push(args.value);return {saved:args.value};
    }}).register({name:'finish',version:1,capability:'read',approval:'never',timeoutMs:1000,retryable:false,inputSchema:z.object({reason:z.string()}),outputSchema:z.unknown(),description:'Close the task',execute:async args=>args,completion:output=>({status:'completed',outcome:'done',reason:'Done',output})}) };
  return {...state,task,execution,env,effects,observations,responses,input:{env,step,runId:task.active_run_id,definition,agent,transport:{model,stream}}};
}

describe('single continuous business loop',()=>{
  it('resumes the saved tool operation when the host fills immediately after the model response',async()=>{
    const f=await fixture();
    const tools=f.input.agent.tools;
    f.input.agent.tools=()=>tools().mapTools(tool=>tool.name==='save_fact' ? {...tool,execute:async(args:any)=>{f.effects.push(args.value);return {saved:args.value};}} : tool);
    f.responses.push(reply([{id:'first',name:'save_fact',arguments:{value:'one'}},{id:'second',name:'save_fact',arguments:{value:'two'}}]),reply([{id:'finish',name:'finish',arguments:{reason:'done'}}]));
    await f.db.prepare('update agent_runtime_executions set durable_steps=199 where id=?').bind(f.execution.id).run();
    await expect(runConversationTask({...f.input,step:executionStep(step,f.env)})).rejects.toBeInstanceOf(ExecutionHandoff);
    expect(f.effects).toEqual([]);
    expect(await f.db.prepare('select count(*) as n from agent_conversation_calls where result_sequence is null').first('n')).toBe(2);
    const next=await createRuntimeExecution(f.db,f.task.active_run_id,f.execution,'workflow_capacity');
    await activateRuntimeExecution(f.db,authorityForExecution(next),next.workflow_id);
    const env=executionEnvironment({DB:f.db} as RuntimeAgentEnv,authorityForExecution(next));
    expect(await runConversationTask({...f.input,env,step:executionStep(step,env)})).toMatchObject({status:'completed'});
    expect(f.effects).toEqual(['one','two']);
    expect(f.observations).toHaveLength(2);
    expect(await f.db.prepare('select count(*) as n from agent_conversation_calls where result_sequence is null').first('n')).toBe(0);
    expect(await f.db.prepare('select count(*) as n from agent_task_operations').first('n')).toBe(3);
  });
  it('crosses 30, 60 and 90 normal decisions with autonomous audits and one T1/R1',async()=>{
    const f=await fixture();
    for(let number=1;number<=90;number++) {
      f.responses.push(reply([{id:`save-${number}`,name:'save_fact',arguments:{value:`progress-${number}`}}]));
      if(number%30===0) f.responses.push(reply([{id:`audit-${number}`,name:'resolve_execution_audit',arguments:{decision:number===90?'finish':'continue',reason:'Recorded business progress',progress:`${number} steps saved`,remaining_work:'Finish the remaining investigation',next_stage_method:'Inspect the next evidence set',outcome:'partial',artifact_refs:[],unresolved_issues:['Remaining evidence gaps']}}]));
    }
    expect(await runConversationTask(f.input)).toMatchObject({status:'completed',outcome:'partial'});
    expect(f.effects).toHaveLength(90);
    expect(f.observations).toHaveLength(93);
    expect(await f.db.prepare('select count(*) as n from agent_runs').first('n')).toBe(1);
    expect(await f.db.prepare('select count(*) as n from agent_runtime_executions').first('n')).toBe(1);
    expect(await f.db.prepare('select normal_decisions from agent_conversations').first('normal_decisions')).toBe(90);
    expect(await f.db.prepare('select count(*) as n from agent_runtime_audits').first('n')).toBe(3);
    expect((await taskForRun(f.db,f.task.active_run_id))?.model_calls).toBe(93);
    expect(await runConversationTask(f.input)).toMatchObject({status:'completed'});
    expect(await f.db.prepare('select count(*) as n from agent_runtime_audits').first('n')).toBe(3);
  });

  it.each(['save_fact','revise_customer'])('persists rejected %s calls and preserves successful siblings',async name=>{
    const f=await fixture(name);
    f.responses.push(reply([{id:'a',name,arguments:{value:'valid'}},{id:'bad',name,arguments:{value:null}},{id:'unknown',name:'missing_tool',arguments:{}}]),
      reply([{id:'fixed',name,arguments:{value:'corrected'}}]),reply([{id:'finish',name:'finish',arguments:{reason:'done'}},{id:'late',name,arguments:{value:'must not execute'}}]));
    expect(await runConversationTask(f.input)).toMatchObject({status:'completed'});
    expect(f.effects).toEqual(['valid','corrected']);
    expect(await f.db.prepare("select count(*) as n from agent_task_operations where status='failed'").first('n')).toBe(3);
    expect(await f.db.prepare('select count(*) as n from agent_conversation_calls where result_sequence is null').first('n')).toBe(0);
    expect(f.observations[1]).toContain('bad');
    expect(f.observations[1]).toContain('missing_tool');
  });
});
