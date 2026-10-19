import { describe, expect, it, vi } from 'vitest';
import { taskTestDb } from './task-test-db';
import { accountExecutionBoundary, accountedEnvironment, accountedStep, observedFetch, requestSampleStatement } from './request-accounting';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
describe('application-visible request accounting', () => {
  it('aggregates into a commit and counts its own write without per-step inserts or cached replay costs', async () => {
    const {db, sqlite, run} = taskTestDb(); const execution = run();
    const env = {DB: db} as RuntimeAgentEnv; const measured = accountedEnvironment(env);
    const cache = new Map();
    const step = accountedStep({do: async (name: string, config: unknown, action?: () => Promise<unknown>) => {
      const fn = (action || config) as () => Promise<unknown>;
      if (!cache.has(name)) cache.set(name, await fn()); return cache.get(name);
    }} as RuntimeWorkflowStep, env, execution.id);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    try {
      await accountExecutionBoundary(env, step, execution.id, async () => {
        const action = async () => { await measured.DB.prepare('select id from agent_runs').all(); await observedFetch('https://example.com'); return 'saved'; };
        await step.do('sample', action); await step.do('sample', action);
        expect(sqlite.prepare('select count(*) n from agent_request_samples').get()).toEqual({n:0});
        await measured.DB.batch([measured.DB.prepare('select 1'), ...requestSampleStatement(measured.DB, execution.id, false, 1)]);
      });
      expect(sqlite.prepare('select fetch_calls,d1_calls,sql_statements,complete from agent_request_samples').get())
        .toEqual({fetch_calls:1,d1_calls:3,sql_statements:4,complete:1});
    } finally { vi.unstubAllGlobals(); }
  });
  it('marks an interrupted execution incomplete rather than reporting zero', async () => {
    const {db,sqlite,run} = taskTestDb(); const execution = run();
    const step = {do: async (_name:string,config:unknown,action?:()=>Promise<unknown>) => (action || config as ()=>Promise<unknown>)()} as RuntimeWorkflowStep;
    await expect(accountExecutionBoundary({DB:db} as RuntimeAgentEnv,step,execution.id,async()=>{throw new Error('stopped');})).rejects.toThrow('stopped');
    expect(sqlite.prepare('select complete,d1_calls from agent_request_samples').get()).toEqual({complete:0,d1_calls:1});
  });
});
it('invokes RPC methods without reading remote call/apply/bind properties', async () => {
  const {db,run} = taskTestDb(); const execution = run();
  const rpc = new Proxy(async (_name: string, fn: () => Promise<unknown>) => fn(), {
    get(_target, key) { throw new Error(`RPC receiver does not implement ${String(key)}`); },
  });
  const step = accountedStep({do: rpc} as RuntimeWorkflowStep, {DB: db} as RuntimeAgentEnv, execution.id);
  await expect(step.do('rpc', async () => 'ok')).resolves.toBe('ok');
});

it('restores accounting when the platform invokes step callbacks outside the parent async scope', async()=>{
  // @ts-ignore Node test-only primitive reproduces Cloudflare callback scope loss.
  const {AsyncResource}=await import('node:async_hooks');
  const platform=new AsyncResource('platform-outside-accounting');
  const {db,sqlite,run}=taskTestDb();const execution=run();const env={DB:db} as RuntimeAgentEnv;
  const step={do:async(_name:string,config:unknown,action?:()=>Promise<unknown>)=>platform.runInAsyncScope((action||config) as ()=>Promise<unknown>)} as RuntimeWorkflowStep;
  await accountExecutionBoundary(env,step,execution.id,async()=>{
    const scoped=accountedStep(step,env,execution.id);
    const measured=accountedEnvironment(env);
    await scoped.do('one-read',async()=>{await measured.DB.prepare('select 1').all();});
  });
  expect(sqlite.prepare('select d1_calls,complete from agent_request_samples').get()).toEqual({d1_calls:2,complete:1});
  platform.emitDestroy();
});
