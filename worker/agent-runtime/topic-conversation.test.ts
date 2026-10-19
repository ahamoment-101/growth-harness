import { SYSTEM_LANGUAGE } from '../../shared/system-language';
import { TOPIC_LIBRARY_INSTRUCTIONS } from './library-business-instructions';
import { expect, it, vi } from 'vitest';
import { taskTestDb } from './task-test-db';
import { agentDefinition } from './definitions';
import { attachTask, requireTask, beginTaskDecision, setTaskAction, finishTaskOperation } from './task-store';
import { initializeConversation } from './conversation-store';
import type { RuntimeAgentEnv } from './env';
import type { AgentModuleExecutionContext } from './agent-modules';

vi.mock('./conversation-runtime', () => ({ runConversationTask: vi.fn(async () => ({ status: 'completed', output: {} })) }));
vi.mock('../db', () => ({ getSiteForWorkspace: vi.fn(async () => ({ id: 's', workspace_id: 'w' })) }));
vi.mock('./topic-decision-context', () => ({ loadTopicDecisionContext: vi.fn() }));
vi.mock('./topic-decision-store', () => ({ persistTopicDecisionResult: vi.fn(async () => ({ id: 'aggregate', outcome: 'submitted' })), topicDecisionSummary: () => ({ groupSize: 2, locales: ['en'] }),
  unfinishedStrategyTask: vi.fn(async () => null), undispatchedTopicResearchRequest: vi.fn(async () => null) }));
vi.mock('./store', () => ({ appendAgentEvent: vi.fn(async () => ({})) }));
vi.mock('../keyword-library/topic-drafts', () => ({ materializeLibraryTopicDrafts: vi.fn(async () => []) }));
import { runConversationTask } from './conversation-runtime';
import { loadTopicDecisionContext } from './topic-decision-context';
import { persistTopicDecisionResult, undispatchedTopicResearchRequest, unfinishedStrategyTask } from './topic-decision-store';
import { appendAgentEvent } from './store';
import { runTopicConversation } from './topic-conversation';

async function libraryTask(runId: string, summary: Record<string, unknown>) {
  const { readFileSync } = await import('node:fs');
  const { KeywordLibrary } = await import('../keyword-library/service');
  const f = taskTestDb();
  f.sqlite.exec("alter table sites add column workspace_id text default 'w'; create table topics(id text primary key,site_id text,title_hint text,status text);");
  f.sqlite.exec(readFileSync(new URL('../../migrations/0056_keyword_library.sql', import.meta.url).pathname, 'utf8'));
  f.sqlite.exec(readFileSync(new URL('../../migrations/0075_language_only_library.sql', import.meta.url).pathname, 'utf8'));
  const library = new KeywordLibrary(f.db as unknown as D1Database, { workspace_id: 'w', site_id: 's', locale: 'en' });
  await library.create('keyword', 'professional email', {}, { operation_id: 'seed', actor: { type: 'human', id: 'test' }, reason: 'Synthetic fixture' });
  const definition = agentDefinition('topic_decision');
  const run = { ...f.run(runId), agent_id: definition.id, summary_json: JSON.stringify(summary) };
  return { f, definition, run, task: await attachTask(f.db, run, definition) };
}

it('refuses to run a topic decision without a language', async () => {
  const { f, definition, run } = await libraryTask('unscoped', { locales: ['en', 'pt-BR'], group_size: 2 });
  await expect(runTopicConversation({ env: { DB: f.db } as RuntimeAgentEnv, run, definition } as unknown as AgentModuleExecutionContext)).rejects.toThrow('language');
});

async function draftTask(runId: string, requested = 3) {
  const { f, definition, run, task } = await libraryTask(runId, { locales: ['en'], scope: { locale: 'en' }, group_size: requested });
  vi.mocked(loadTopicDecisionContext).mockResolvedValue([
    { sourceId: 'run_constraints', value: { locales: ['en'], requested_count: requested }, version: '1' },
    { sourceId: 'active_strategies', value: [{ locale: 'en', version: { id: 'strategy-en', version: 1 }, keywords: [] }], version: '1' },
  ] as never);
  vi.mocked(persistTopicDecisionResult).mockClear();
  await runTopicConversation({ env: { DB: f.db } as RuntimeAgentEnv, run, definition } as unknown as AgentModuleExecutionContext);
  const spec = vi.mocked(runConversationTask).mock.calls.at(-1)![0];
  const initial: any = await spec.agent.context(task);
  await initializeConversation(f.db, task, spec.agent.instructions, initial);
  async function call(name: string, input: any, replay?: any) {
    const current = await requireTask(f.db, run.id);
    const operation = replay || await beginTaskDecision(f.db, current, {});
    if (!replay) await setTaskAction(f.db, current, operation, { name, input });
    try {
      const output: any = await spec.agent.tools(current, operation).execute(spec.definition, name, input, { runId: run.id, workspaceId: 'w', siteId: 's', idempotencyKey: operation.id });
      await finishTaskOperation(f.db, current, operation, output);
      return { output, operation };
    } catch (error) { await finishTaskOperation(f.db, current, operation, {}, String(error)); throw error; }
  }
  const opened = (await call('open_keyword_library', { locale: 'en' })).output;
  const words = (await call('list_library_entries', { library_ref: opened.library_ref, kind: 'keyword' })).output;
  const topic = (topic_key: string, keyword_ref = words.items[0].id) => ({ keyword_ref, topic_key, title_direction: topic_key, content_type: 'GUIDE', search_intent: 'learn', group_role: 'direction', rationale: 'Distinct need', hypothesis: 'Useful', evidence: [{ source_type: 'business', ref: 'business_constraints', summary: 'Synthetic editorial request' }] });
  const header = { rationale: 'Email portfolio', goal: 'Email guides', hypothesis: 'Complementary pages', expected_signals: ['impressions'] };
  const draft = async () => JSON.parse((await f.db.prepare('select workspace_json from agent_tasks where id=?').bind(task.id).first<{ workspace_json: string }>())!.workspace_json);
  return { f, spec, task, run, words, call, topic, header, draft };
}

it('builds one topic draft through small edits and submits it once as a locked batch', async () => {
  const { spec, task, words, call, topic, header, draft } = await draftTask('draft-lifecycle');
  expect(spec.agent.instructions).toContain(TOPIC_LIBRARY_INSTRUCTIONS);
  expect(spec.agent.instructions).not.toMatch(/[\u3400-\u9fff]/);
  const { z } = await import('zod');
  const inputOf = (name: string) => z.toJSONSchema(spec.agent.tools(task).resolve(spec.definition, name).inputSchema, { io: 'input' }) as any;
  const topicInput = inputOf('add_topics').properties.topics.items;
  for (const key of ['keyword_id', 'strategy_keyword_id', 'primary_keyword', 'locale', 'market']) expect(topicInput.properties[key]).toBeUndefined();
  expect(topicInput.required).toEqual(expect.arrayContaining(['keyword_ref', 'topic_key', 'title_direction', 'search_intent', 'group_role', 'rationale', 'hypothesis', 'evidence']));
  expect(topicInput.required).not.toEqual(expect.arrayContaining(['risk']));
  expect(topicInput.required).not.toContain('relationship_to_existing');
  expect(inputOf('write_topic_group').required).not.toEqual(expect.arrayContaining(['risks']));
  for (const name of ['write_topic_group', 'request_topic_research', 'defer_topic_decision']) expect(JSON.stringify(inputOf(name))).not.toContain('"null"');
  expect((await call('read_topic_state', {})).output).toMatchObject({ system_language: SYSTEM_LANGUAGE, submitted: null, draft: { group: null, topic_count: 0, requested_count: 3 } });

  // Topics may come before the group description; optional fields may be omitted and keywords selected by id or observation_ref.
  expect((await call('add_topics', { topics: [topic('first-contact'), topic('reply-tone', words.items[0].observation_ref)] })).output).toEqual({ accepted: true, group_written: false, topic_count: 2, requested_count: 3, added_topic_keys: ['first-contact', 'reply-tone'], revised_topic_keys: [], removed_topic_keys: [] });
  const written = await call('write_topic_group', header);
  expect(written.output).toMatchObject({ accepted: true, group_written: true, topic_count: 2, added_topic_keys: [] });
  expect((await draft()).group).toMatchObject({ goal: 'Email guides', risks: [] });
  expect((await call('write_topic_group', header, written.operation)).output).toMatchObject({ accepted: true });

  await expect(call('add_topics', { topics: [topic('First-Contact')] })).rejects.toMatchObject({ details: { kind: 'invalid_request', effects: 'none' } });
  await expect(call('add_topics', { topics: [topic('unknown-word', 'missing-keyword-id')] })).rejects.toThrow('not present in this language');
  const unverified = await call('add_topics', { topics: [{ ...topic('web-claim'), evidence: [{ source_type: 'web', ref: 'https://invented.example', summary: 'Not searched' }] }] });
  expect(unverified.output).toMatchObject({ accepted: false, effects: 'none' });
  expect((await call('add_topics', { topics: [topic('follow-up')] })).output).toMatchObject({ accepted: true, topic_count: 3, added_topic_keys: ['follow-up'] });
  expect((await call('add_topics', { topics: [topic('fourth')] })).output).toMatchObject({ accepted: false, effects: 'none' });
  expect((await draft()).topics).toHaveLength(3);

  expect((await call('revise_topic', { topic_key: 'reply-tone', changes: { title_direction: 'Reply tone guide', risk: 'Tone varies by culture' } })).output).toMatchObject({ revised_topic_keys: ['reply-tone'], added_topic_keys: [], removed_topic_keys: [] });
  await expect(call('revise_topic', { topic_key: 'absent', changes: { title_direction: 'x' } })).rejects.toThrow('no topic absent');
  expect((await call('remove_topics', { topic_keys: ['follow-up'] })).output).toMatchObject({ topic_count: 2, removed_topic_keys: ['follow-up'] });
  const full = (await call('read_topic_state', { topic_key: 'REPLY-TONE' })).output;
  expect(full.topic).toMatchObject({ title_direction: 'Reply tone guide', risk: 'Tone varies by culture', relationship_to_existing: '', primary_keyword: 'professional email', library_keyword_id: words.items[0].id, locale: 'en' });
  expect(full.draft.topics.map((row: any) => row.topic_key)).toEqual(['first-contact', 'reply-tone']);

  const submitted = await call('submit_topic_group', {});
  expect(submitted.output).toMatchObject({ accepted: true, outcome: 'submitted', id: 'aggregate' });
  const persisted = vi.mocked(persistTopicDecisionResult).mock.calls.at(-1)![0];
  expect(persisted).toMatchObject({ scope: { locale: 'en' }, locales: ['en'], strategyVersionId: 'strategy-en', strategyVersion: 1 });
  expect(persisted.output.group?.items.map(item => item.topic_key)).toEqual(['first-contact', 'reply-tone']);
  expect(persisted.output.group?.goal).toBe('[en] Email guides');

  await expect(call('submit_topic_group', {})).rejects.toThrow('draft is locked');
  await expect(call('add_topics', { topics: [topic('late')] })).rejects.toThrow('draft is locked');
  await expect(call('request_topic_research', { rationale: 'late', gap: 'g', why_blocking: 'w', known: [], unknown: ['u'], requested_evidence: ['e'], reconsider_after: 'r' })).rejects.toThrow('draft is locked');
  expect(vi.mocked(persistTopicDecisionResult)).toHaveBeenCalledTimes(1);
  expect((await call('read_topic_state', {})).output.submitted).toMatchObject({ tool: 'submit_topic_group' });
  expect((await call('finish_topic_decision', { outcome: 'completed', reason: 'Two guides submitted' })).output).toMatchObject({ outcome: 'completed', id: 'aggregate' });
});

it('requires a complete group, keeps drafted topics from being silently concluded away and rechecks keywords', async () => {
  const { f, words, call, topic, header } = await draftTask('draft-guards');
  const research = { rationale: 'Demand unclear', gap: 'No search expressions', why_blocking: 'Cannot size pages', known: [], unknown: ['wording'], requested_evidence: ['autocomplete'], reconsider_after: 'research' };
  await expect(call('submit_topic_group', {})).rejects.toThrow('no group description');
  expect((await call('write_topic_group', header)).output).toMatchObject({ accepted: true, group_written: true, topic_count: 0 });
  await expect(call('submit_topic_group', {})).rejects.toThrow('no topics');
  await call('add_topics', { topics: [topic('first-contact')] });
  await expect(call('request_topic_research', research)).rejects.toThrow('still holds 1 topics');
  await expect(call('defer_topic_decision', { rationale: 'wait', reason: 'r', blockers: ['b'], recommended_action: 'a', resume_when: 'w' })).rejects.toThrow('still holds 1 topics');
  f.sqlite.prepare('update keyword_library_entries set name=? where id=?').run('renamed keyword', words.items[0].id);
  await expect(call('submit_topic_group', {})).rejects.toThrow('renamed');
  expect(vi.mocked(persistTopicDecisionResult)).not.toHaveBeenCalled();
  await call('remove_topics', { topic_keys: ['first-contact'] });
  expect((await call('request_topic_research', research)).output).toMatchObject({ accepted: true, decision: 'needs_research' });
  expect(vi.mocked(persistTopicDecisionResult).mock.calls.at(-1)![0].output).toMatchObject({ decision_type: 'needs_research', group: null, research_request: { gap: 'No search expressions' } });
  await expect(call('write_topic_group', header)).rejects.toThrow('draft is locked');
  await expect(call('defer_topic_decision', { rationale: 'wait', reason: 'r', blockers: ['b'], recommended_action: 'a', resume_when: 'w' })).rejects.toThrow('draft is locked');
});

it('does not report completion before a submission and accepts an empty-draft deferral', async () => {
  const { call } = await draftTask('draft-defer');
  await expect(call('finish_topic_decision', { outcome: 'completed', reason: 'nothing saved' })).rejects.toThrow('Submit the decision');
  expect((await call('defer_topic_decision', { rationale: 'Library too thin', reason: 'No keywords', blockers: ['empty library'], recommended_action: 'Run keyword research', resume_when: 'Library has keywords' })).output).toMatchObject({ accepted: true, decision: 'defer' });
  await expect(call('submit_topic_group', {})).rejects.toThrow('draft is locked');
  expect((await call('finish_topic_decision', { outcome: 'completed', reason: 'Deferred' })).output).toMatchObject({ decision: 'defer' });
});

it('waits for unfinished strategy research or an unstarted research request before starting the conversation', async () => {
  const { f, definition, run, task } = await libraryTask('strategy-gate', { locales: ['en'], scope: { locale: 'en' }, group_size: 2 });
  vi.mocked(loadTopicDecisionContext).mockResolvedValue([
    { sourceId: 'run_constraints', value: { locales: ['en'], requested_count: 2 }, version: '1' },
    { sourceId: 'active_strategies', value: [{ locale: 'en', version: { id: null, version: 0 }, keywords: [] }], version: '1' },
  ] as never);
  vi.mocked(runConversationTask).mockClear();
  vi.mocked(unfinishedStrategyTask).mockResolvedValueOnce({ id: 'strategy-1', status: 'paused' }).mockResolvedValueOnce(null).mockResolvedValue(null);
  vi.mocked(undispatchedTopicResearchRequest).mockResolvedValueOnce({ id: 'request-1' }).mockResolvedValue(null);
  const sleeps: string[] = [];
  const step = { sleep: vi.fn(async (name: string, duration: string) => { sleeps.push(`${name}:${duration}`); expect(runConversationTask).not.toHaveBeenCalled(); }) };
  await runTopicConversation({ env: { DB: f.db } as RuntimeAgentEnv, run, definition, step } as unknown as AgentModuleExecutionContext);
  expect(sleeps).toEqual(['strategy-gate-0:3 minutes', 'strategy-gate-1:3 minutes']);
  expect(vi.mocked(unfinishedStrategyTask)).toHaveBeenCalledWith(f.db, run.workspace_id, run.site_id, 'en');
  expect(vi.mocked(appendAgentEvent).mock.calls.map(call => call[1].eventKey)).toEqual(['strategy-gate:strategy-1', 'strategy-gate:request-1']);
  expect(runConversationTask).toHaveBeenCalledTimes(1);

  // A conversation that already started is resumed without waiting again.
  const spec = vi.mocked(runConversationTask).mock.calls.at(-1)![0];
  await initializeConversation(f.db, task, spec.agent.instructions, await spec.agent.context(task));
  vi.mocked(unfinishedStrategyTask).mockResolvedValueOnce({ id: 'strategy-2', status: 'running' });
  await runTopicConversation({ env: { DB: f.db } as RuntimeAgentEnv, run, definition, step } as unknown as AgentModuleExecutionContext);
  expect(sleeps).toHaveLength(2);
  expect(runConversationTask).toHaveBeenCalledTimes(2);
});
