import { expect,it } from 'vitest';
import { faultAwareStep } from './platform-step';
import type { RuntimeWorkflowStep } from './env';
it.each(['API requests','subrequests'])('does not retry a native %s refusal in the Workflow retry engine',async(kind)=>{
  let calls=0;
  const step=faultAwareStep({do:async(_name:string,fn:()=>Promise<unknown>)=>{
    for(let retry=0;;retry++){try{return JSON.parse(JSON.stringify(await fn()));}catch(error){if(retry===2)throw error;}}
  }} as RuntimeWorkflowStep);
  await expect(step.do('database',async()=>{calls++;throw new Error(`Too many ${kind} by single Worker invocation.`);})).rejects.toMatchObject({failure:{origin:'local_platform',recovery_action:'new_execution'}});
  expect(calls).toBe(1);
});
it('retains normal step retries for upstream 503 responses',async()=>{
  let calls=0;
  const step=faultAwareStep({do:async(_name:string,fn:()=>Promise<unknown>)=>{try{return await fn();}catch{return await fn();}}} as RuntimeWorkflowStep);
  await expect(step.do('upstream',async()=>{if(++calls===1)throw Object.assign(new Error('Too many API requests by single Worker invocation.'),{status:503});return 'ok';})).resolves.toBe('ok');
  expect(calls).toBe(2);
});
