// @ts-ignore Tests run on Node's SQLite; production never imports this helper.
import { DatabaseSync } from 'node:sqlite';
// @ts-ignore Node test-only dependency.
import { readFileSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';
import type { AgentRun } from './protocol';
import { agentDefinition } from './definitions';
export function taskTestDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec("create table sites(id text primary key); insert into sites values('s');");
  for (const file of ['0017_agent_runtime_core.sql', '0020_agent_model_results.sql', '0027_agent_runtime_v2.sql', '0037_agent_decision_results.sql', '0039_agent_tasks.sql', '0040_research_tasks.sql', '0042_research_notebook_history.sql', '0043_task_execution_recovery.sql', '0044_recovery_dispatch_claim.sql', '0045_request_accounting.sql', '0046_decision_attempt_metrics.sql', '0047_agent_conversations.sql', '0048_firecrawl_research_jobs.sql', '0049_agent_execution_stages.sql', '0050_agent_parameter_slots.sql', '0051_continuous_runtime.sql', '0053_runtime_identity_invariants.sql']) {
    // @ts-ignore Node test-only URL.
    sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
  }
  sqlite.exec("alter table agent_runs add column agent_instance_id text not null default ''; alter table agent_runs add column schedule_key text not null default ''; drop index agent_runs_one_active_idx;");
  // @ts-ignore Node test-only URL.
  sqlite.exec(readFileSync(new URL('../../migrations/0054_research_source_indexes.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0063_agent_work.sql', import.meta.url).pathname, 'utf8').split('alter table topic_decision_results')[0]);
  sqlite.exec(readFileSync(new URL('../../migrations/0064_work_requests.sql', import.meta.url).pathname, 'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0068_runtime_request_blobs.sql', import.meta.url).pathname, 'utf8'));
  const counts = { d1: 0, statements: 0 };
  let batching = false;
  const counted = () => { counts.statements++; if (!batching) counts.d1++; };
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind: (...args: unknown[]) => { values = args; return statement; },
      first: async <T>(column?: string) => { counted(); const row = sqlite.prepare(sql).get(...values as never[]) as Record<string, unknown> | undefined; return (column ? row?.[column] : row) as T ?? null; },
      all: async <T>() => { counted(); return { results: sqlite.prepare(sql).all(...values as never[]) as T[] }; },
      run: async () => { counted(); return { meta: { changes: Number(sqlite.prepare(sql).run(...values as never[]).changes) } }; },
    };
    return statement;
  };
  let batchTail: Promise<unknown> = Promise.resolve();
  const db = { prepare, batch: (statements: Array<{run(): Promise<unknown>}>) => {
    const pending = batchTail.then(async () => {
    counts.d1++; batching = true;
    sqlite.exec('begin');
    try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('commit'); return result; }
    catch (error) { sqlite.exec('rollback'); throw error; }
    finally { batching = false; }
    });
    batchTail = pending.catch(() => undefined);
    return pending;
  } } as unknown as D1Database;
  const run = (id = 'run-1', instance = 'strategy:en'): AgentRun => {
    const definition = agentDefinition('strategy_research');
    sqlite.prepare(`insert into agent_runs(id,workspace_id,site_id,agent_id,agent_instance_id,definition_version,prompt_version,trigger,status,phase,root_run_id,summary_json,created_at,updated_at)
      values(?,'w','s','strategy_research',?,?,?,'manual','running','task',?,?,?,?)`)
      .run(id, instance, definition.definitionVersion, definition.promptVersion, id, JSON.stringify({ locale: 'en' }), new Date().toISOString(), new Date().toISOString());
    return sqlite.prepare('select * from agent_runs where id = ?').get(id) as AgentRun;
  };
  return { db, sqlite, run, counts };
}

export async function resumeTestTask(db: D1Database, runId: string) {
  const { createRuntimeExecution, currentExecution, activateRuntimeExecution, authorityForExecution } = await import('./runtime-executions');
  const { requireTask } = await import('./task-store');
  await db.prepare("update agent_task_model_reservations set status='failed',outcome_state='unknown' where task_id=(select id from agent_tasks where active_run_id=?) and status='running'").bind(runId).run();
  const previous = await currentExecution(db, runId) || await createRuntimeExecution(db, runId);
  const execution = await createRuntimeExecution(db, runId, previous, 'test_recovery');
  await activateRuntimeExecution(db, authorityForExecution(execution), execution.workflow_id);
  return requireTask(db, runId);
}
