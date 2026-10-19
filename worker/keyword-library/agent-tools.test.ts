// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { agentDefinition } from '../agent-runtime/definitions';
import { attachTask, beginTaskDecision, finishTaskOperation, requireTask, setTaskAction } from '../agent-runtime/task-store';
import { createRuntimeExecution, activateRuntimeExecution, authorityForExecution } from '../agent-runtime/runtime-executions';
import { executionDatabase } from '../agent-runtime/execution-context';
import { mountLibraryTools } from './agent-tools';
import { ToolRegistry } from '../agent-runtime/tools';

it('persists observed selectors across calls, freezes replay inputs, and rejects cross-market/stale observations', async () => {
  const f = taskTestDb();
  f.sqlite.exec("alter table sites add column workspace_id text default 'w'; create table topics(id text primary key,site_id text,title_hint text,status text);");
  f.sqlite.exec("alter table topics add column plan_json text default '{}';");
  // @ts-ignore Test-only URL.
  f.sqlite.exec(readFileSync(new URL('../../migrations/0056_keyword_library.sql', import.meta.url), 'utf8'));
  f.sqlite.exec(readFileSync(new URL('../../migrations/0075_language_only_library.sql', import.meta.url).pathname, 'utf8'));
  const run = f.run(); const definition = agentDefinition('strategy_research');
  await attachTask(f.db, run, definition);
  const execution = await createRuntimeExecution(f.db, run.id); const authority = authorityForExecution(execution);
  await activateRuntimeExecution(f.db, authority, execution.workflow_id);
  const db = executionDatabase(f.db, authority);
  async function call(name: string, args: any, prior?: any) {
    const task = await requireTask(db, run.id);
    const operation = prior || await beginTaskDecision(db, task, {});
    if (!prior) await setTaskAction(db, task, operation, { name, input: args });
    const registry = mountLibraryTools(new ToolRegistry(), { db: db as unknown as D1Database, task, operation, locales: ['en', 'pt-BR'], sets: ['read', 'research'] });
    const output: any = await registry.execute(definition, name, args, { workspaceId: 'w', siteId: 's', runId: run.id, idempotencyKey: operation.id, execution: authority });
    if (!prior) await finishTaskOperation(db, task, operation, output);
    return { output, operation };
  }
  const us = (await call('open_keyword_library', { locale: 'en' })).output;
  const uk = (await call('open_keyword_library', { locale: 'pt-BR' })).output;
  const created = await call('create_library_keyword', { library_ref: us.library_ref, name: 'email', data: {}, reason: 'Synthetic research' });
  const args = { library_ref: us.library_ref, reference: created.output.observation_ref, data: { priority: 'high' }, reason: 'Observed opportunity' };
  const changed = await call('revise_library_keyword', args);
  expect((await call('revise_library_keyword', args, changed.operation)).output).toEqual(changed.output);
  const read = (await call('read_library_entry', { library_ref: us.library_ref, reference: changed.output.observation_ref })).output;
  expect(read.entry.data.priority).toBe('high');
  expect(read.entry.observation_ref).toBeTruthy();
  await expect(call('revise_library_keyword', { ...args, library_ref: uk.library_ref })).rejects.toThrow('different language');
  expect(f.sqlite.prepare('select count(*) as n from keyword_library_logs').get()).toEqual({ n: 2 });
});

it('relates topics to keywords selected by observation, id or exact name without requiring the latest observation', async () => {
  const f = taskTestDb();
  f.sqlite.exec("alter table sites add column workspace_id text default 'w'; create table topics(id text primary key,site_id text,title_hint text,status text);");
  f.sqlite.exec("alter table topics add column plan_json text default '{}'; insert into topics(id,site_id,title_hint,status) values('t1','s','Reply guide','draft'),('t2','s','Tone guide','draft'),('t3','s','Phrase list','draft');");
  // @ts-ignore Test-only URL.
  f.sqlite.exec(readFileSync(new URL('../../migrations/0056_keyword_library.sql', import.meta.url), 'utf8'));
  f.sqlite.exec(readFileSync(new URL('../../migrations/0075_language_only_library.sql', import.meta.url).pathname, 'utf8'));
  const run = f.run(); const definition = agentDefinition('topic_decision');
  await attachTask(f.db, run, definition);
  const execution = await createRuntimeExecution(f.db, run.id); const authority = authorityForExecution(execution);
  await activateRuntimeExecution(f.db, authority, execution.workflow_id);
  const db = executionDatabase(f.db, authority);
  async function call(name: string, args: any) {
    const task = await requireTask(db, run.id);
    const operation = await beginTaskDecision(db, task, {});
    await setTaskAction(db, task, operation, { name, input: args });
    const registry = mountLibraryTools(new ToolRegistry(), { db: db as unknown as D1Database, task, operation, locales: ['en'], sets: ['read', 'topicLinks'] });
    try {
      const output: any = await registry.execute(definition, name, args, { workspaceId: 'w', siteId: 's', runId: run.id, idempotencyKey: operation.id, execution: authority });
      await finishTaskOperation(db, task, operation, output);
      return output;
    } catch (error) { await finishTaskOperation(db, task, operation, {}, String(error)); throw error; }
  }
  const { KeywordLibrary } = await import('./service');
  const word = await new KeywordLibrary(f.db as unknown as D1Database, { workspace_id: 'w', site_id: 's', locale: 'en' })
    .create('keyword', 'Email Reply Practice', {}, { operation_id: 'seed', actor: { type: 'human', id: 'test' }, reason: 'Synthetic fixture' });
  const us = await call('open_keyword_library', { locale: 'en' });
  const listed = await call('list_library_entries', { library_ref: us.library_ref, kind: 'keyword' });
  const link = (keyword: string, topic: string) => call('relate_library_topic', { library_ref: us.library_ref, keyword, topic, relationship: 'primary', reason: 'Same reader task' });
  await link(listed.items[0].observation_ref, 't1');
  await link(listed.items[0].observation_ref, 't2');
  await link(' email reply practice ', 't3');
  await link(word.target_id, 't1');
  expect(f.sqlite.prepare('select topic_id from keyword_library_topic_links order by topic_id').all()).toEqual([{ topic_id: 't1' }, { topic_id: 't2' }, { topic_id: 't3' }]);
  await expect(link('email reply practise', 't1')).rejects.toThrow('No keyword named');
  expect(f.sqlite.prepare('select revision from keyword_library_entries').get()).toEqual({ revision: 5 });
});
