import { taskTestDb } from './task-test-db';
import { agentDefinition, type AgentId } from './definitions';
import { attachTask, requireTask } from './task-store';
import { persistRuntimeJson } from './runtime-content';
import { executionEnvironment } from './execution-context';
import { activateRuntimeExecution, authorityForExecution, createRuntimeExecution } from './runtime-executions';
import type { RuntimeAgentEnv } from './env';
export async function editorialFixture() {
  const f = taskTestDb();
  f.sqlite.exec(`create table content_production_groups(id text,workspace_id text,site_id text,parent_run_id text);
    create table jobs(id text,production_group_id text);
    insert into content_production_groups values('g','w','s','parent');insert into jobs values('j','g');`);
  const objects = new Map<string, string>();
  const bucket = { put: async (key: string, value: string) => { objects.set(key,value); return { etag: key }; },
    head: async (key: string) => objects.has(key) ? { size: new TextEncoder().encode(objects.get(key)).length, etag: key } : null,
    get: async (key: string, options?: { range?: { offset: number; length: number } }) => objects.has(key) ? { text: async () => objects.get(key)!, arrayBuffer: async () => { const bytes = new TextEncoder().encode(objects.get(key)!); return options?.range ? bytes.slice(options.range.offset, options.range.offset + options.range.length).buffer : bytes.buffer; } } : null };
  const env = { DB: f.db, RESEARCH_BUCKET: bucket } as unknown as RuntimeAgentEnv;
  async function task(id: string, agentId: AgentId, material: unknown = { job_id: 'j' }) {
    const run = f.run(id,id); run.agent_id=agentId;
    f.sqlite.prepare('update agent_runs set agent_id=? where id=?').run(agentId,id);
    const attached = await attachTask(f.db,run,agentDefinition(agentId));
    const assignment = await persistRuntimeJson(f.db, material);
    f.sqlite.prepare('insert into agent_task_assignments(id,task_id,operation_id,context_json,created_at) values(?,?,?,?,?)').run(id,id,id,assignment,'now');
    f.sqlite.prepare('update agent_tasks set assignment_id=? where id=?').run(id,id);
    const execution = await createRuntimeExecution(f.db,id);
    await activateRuntimeExecution(f.db,authorityForExecution(execution),execution.workflow_id);
    const scoped = executionEnvironment(env,authorityForExecution(execution));
    return { task: await requireTask(scoped.DB,id), env: scoped, context: {runId:id,workspaceId:'w',siteId:'s',idempotencyKey:id+':operation'}, attached };
  }
  return { ...f, env, objects, task };
}
