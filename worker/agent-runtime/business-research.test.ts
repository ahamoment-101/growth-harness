// @ts-ignore Test-only Node filesystem.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { taskTestDb } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, beginTaskDecision, setTaskAction, stopTask } from './task-store';
import { saveResearchedDocument } from './business-research';
import { listBusinessModules, saveBusinessModule } from '../lib/business';
import type { RuntimeAgentEnv } from './env';

async function fixture() {
  const state = taskTestDb();
  for (const file of ['0013_business_modules.sql', '0014_business_module_markdown.sql']) {
    // @ts-ignore Test-only URL.
    state.sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const run = state.run();
  const task = await attachTask(state.db, run, agentDefinition('strategy_research'));
  const operation = await beginTaskDecision(state.db, task, {});
  await setTaskAction(state.db, task, operation, { name: 'save_business_document' });
  state.sqlite.prepare(`insert into research_sources(id,task_id,workspace_id,site_id,url,title,captured_at,object_key,content_hash,content_length) values('source',?,'w','s','https://example.com','Example','now','key','hash',12)`).run(task.id);
  return { ...state, task, operation, env: { DB: state.db } as RuntimeAgentEnv,
    args: { key: 'product' as const, expected_version: 0, markdown: '# Product information\n\n## One-line introduction\n\nObserved product.', source_ids: ['source'] } };
}

describe('business research document persistence', () => {
  it('saves readable Markdown with provenance and replays without overwriting later manual edits', async () => {
    const f = await fixture();
    await saveResearchedDocument(f.env, f.task, f.operation, f.args);
    expect((await listBusinessModules(f.db, 's'))[0]).toMatchObject({ version: 1, source: 'website_research' });
    expect((await listBusinessModules(f.db, 's'))[0].markdown).toContain('https://example.com');
    await saveBusinessModule(f.db, 's', 'product', '# Human edit');
    await saveResearchedDocument(f.env, f.task, f.operation, f.args);
    expect((await listBusinessModules(f.db, 's'))[0]).toMatchObject({ version: 2, markdown: '# Human edit' });
  });
  it('preserves concurrent manual edits and sibling documents', async () => {
    const f = await fixture();
    await saveBusinessModule(f.db, 's', 'audience', '# Existing audience');
    await saveBusinessModule(f.db, 's', 'product', '# New manual fact');
    await expect(saveResearchedDocument(f.env, f.task, f.operation, f.args)).rejects.toThrow('changed');
    expect((await listBusinessModules(f.db, 's')).filter(m => m.version).map(m => m.markdown)).toEqual(['# New manual fact', '# Existing audience']);
  });
  it('rejects invented source references and cancelled execution without writing', async () => {
    const f = await fixture();
    await expect(saveResearchedDocument(f.env, f.task, f.operation, { ...f.args, source_ids: ['invented'] })).rejects.toThrow('Unknown page');
    await stopTask(f.db, f.task.active_run_id, 'cancelled', 'cancel');
    await expect(saveResearchedDocument(f.env, f.task, f.operation, f.args)).rejects.toThrow('changed');
    expect((await listBusinessModules(f.db, 's')).every(m => m.version === 0)).toBe(true);
  });
});

it('preserves long researched and manual documents without silent truncation', async () => {
  const f = await fixture();
  const markdown = '# Product\n' + 'Evidence. '.repeat(4000) + '\nFinal entity: customer-789';
  await saveResearchedDocument(f.env, f.task, f.operation, { ...f.args, markdown });
  expect((await listBusinessModules(f.db, 's'))[0].markdown).toContain(markdown);
  await saveBusinessModule(f.db, 's', 'product', markdown);
  expect((await listBusinessModules(f.db, 's'))[0].markdown).toBe(markdown);
});
