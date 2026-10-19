import { SYSTEM_LANGUAGE } from '../../shared/system-language';
import { ToolContractError } from './tool-failure';
import { topicScope } from './topic-scope';
import { materializeLibraryTopicDrafts } from '../keyword-library/topic-drafts';
import { type LibraryObservation } from '../keyword-library/agent-tools';
import { KeywordLibrary } from '../keyword-library/service';
import { TOPIC_LIBRARY_INSTRUCTIONS } from './library-business-instructions';
import { readRuntimeJson } from './runtime-content';
import { z } from 'zod';
import type { AgentModuleExecutionContext } from './agent-modules';
import { runConversationTask } from './conversation-runtime';
import { loadTopicDecisionContext } from './topic-decision-context';
import { createTopicDecisionToolRegistry, normalizeTopicWebEvidence, topicSearchWebInputSchema, type TopicWebEvidence } from './topic-decision-tools';
import { topicDecisionItemSchema, topicDecisionOutputSchema, aggregateLanguageTopicDecisions, type TopicDecisionItemOutput, type TopicDecisionOutput } from './topic-decision-contract';
import { topicDecisionSubmissionFeedback } from './topic-decision-validation';
import { persistTopicDecisionResult, topicDecisionSummary, undispatchedTopicResearchRequest, unfinishedStrategyTask } from './topic-decision-store';
import { appendAgentEvent } from './store';
import { requireTask, taskForRun, writeTaskWorkspace, type AgentTask, type TaskOperation } from './task-store';
import { getSiteForWorkspace } from '../db';
import { resolveSlot, bindOperation } from './parameter-slots';
import { searchTaskWeb } from './task-usage';

/**
 * The topic Agent builds one approval batch in its task workspace, then submits it once.
 *
 * The draft has the delivered group's shape, so submission persists it without a
 * translation step. Edits select topics by the model's own topic_key; writes within one
 * task are sequential, so they do not require a previously observed revision.
 */
const groupSchema = topicDecisionOutputSchema.shape.group.unwrap();
const groupHeaderSchema = groupSchema.omit({ items: true }).extend({
  rationale: topicDecisionOutputSchema.shape.rationale,
  risks: groupSchema.shape.risks.default([]),
  unknowns: groupSchema.shape.unknowns.default([]),
  previous_group_relationship: groupSchema.shape.previous_group_relationship.default(''),
});
type GroupHeader = z.output<typeof groupHeaderSchema>;
const topicInputSchema = topicDecisionItemSchema.omit({ library_keyword_id: true, strategy_keyword_id: true, keyword_id: true, primary_keyword: true, locale: true }).extend({
  keyword_ref: z.string().trim().min(1).max(200).describe('The keyword this topic targets: its observation_ref from a library read, or its id as listed in this language.'),
  relationship_to_existing: topicDecisionItemSchema.shape.relationship_to_existing.default(''),
  risk: topicDecisionItemSchema.shape.risk.default(''),
});
type TopicInput = z.output<typeof topicInputSchema>;
const topicChangesSchema = topicInputSchema.omit({ topic_key: true }).partial().refine(value => Object.keys(value).length > 0, 'Name at least one field to change');
const researchSchema = topicDecisionOutputSchema.shape.research_request.unwrap().extend({ rationale: topicDecisionOutputSchema.shape.rationale });
const deferSchema = topicDecisionOutputSchema.shape.defer.unwrap().extend({ rationale: topicDecisionOutputSchema.shape.rationale });

type TopicDraft = { group: GroupHeader | null; topics: TopicDecisionItemOutput[] };
const SUBMIT_TOOLS = ['submit_topic_group', 'request_topic_research', 'defer_topic_decision'] as const;
const PENDING_HEADER: GroupHeader = { rationale: 'pending', goal: 'pending', hypothesis: 'pending', expected_signals: ['pending'], risks: [], unknowns: [], previous_group_relationship: '' };
const topicKey = (value: string) => value.trim().toLowerCase();
const rejected = (message: string, path: Array<string | number>, guidance: string): never => {
  throw new ToolContractError(message, { kind: 'invalid_request', effects: 'none', issues: [{ path, message }], guidance });
};

export async function runTopicConversation(input: AgentModuleExecutionContext) {
  const { env, run } = input;
  const scope = topicScope(run.summary_json);
  if (!scope) throw new Error('Topic decision requires a language');
  const definition = { ...input.definition, tools: [...input.definition.tools, 'read_topic_state', 'write_topic_group', 'add_topics', 'revise_topic', 'remove_topics', ...SUBMIT_TOOLS, 'finish_topic_decision'] };
  const libraryLocale = new Intl.Locale(scope.locale).toString();
  const evidence = async (task: AgentTask): Promise<TopicWebEvidence[]> => {
    const rows = await env.DB.prepare("select output_json from agent_task_operations where task_id=? and status='succeeded' and json_extract(action_json,'$.name')='topic_search_web' order by turn").bind(task.id).all<{output_json:string}>();
    return (await Promise.all(rows.results.map(row => readRuntimeJson<TopicWebEvidence[]>(env.DB, row.output_json)))).flat();
  };
  const initialContext = async (task: AgentTask) => {
    const row = await env.DB.prepare('select context_json from agent_conversations where task_id=?').bind(task.id).first<{context_json:string}>();
    if (!row) throw new Error('Task language observation is missing');
    return readRuntimeJson<{ run_constraints: Record<string, unknown>; active_strategy: { version: { id: string | null; version: number } } }>(env.DB, row.context_json);
  };
  const readDraft = async (task: AgentTask) => {
    const current = await requireTask(env.DB, task.active_run_id);
    const saved = await readRuntimeJson<Partial<TopicDraft>>(env.DB, current.workspace_json);
    return { revision: current.revision, draft: { group: saved.group || null, topics: saved.topics || [] } as TopicDraft };
  };
  const submission = async (task: AgentTask) => {
    const row = await env.DB.prepare(`select json_extract(action_json,'$.name') as name,output_json from agent_task_operations where task_id=? and status='succeeded'
      and json_extract(action_json,'$.name') in (${SUBMIT_TOOLS.map(() => '?').join(',')}) and coalesce(json_extract(output_json,'$.accepted'),1)!=0 order by turn limit 1`)
      .bind(task.id, ...SUBMIT_TOOLS).first<{ name: string; output_json: string }>();
    return row ? { tool: row.name, receipt: await readRuntimeJson<Record<string, unknown>>(env.DB, row.output_json) } : null;
  };
  const assertOpen = async (task: AgentTask) => {
    const submitted = await submission(task);
    if (submitted) rejected(`This task already submitted its decision with ${submitted.tool}; the draft is locked`, [], 'The submitted decision stands. Report it, or relate keywords to its topics.');
  };
  const outline = (draft: TopicDraft, constraints: Record<string, unknown>) => ({
    group: draft.group, topic_count: draft.topics.length, requested_count: constraints.requested_count,
    topics: draft.topics.map(topic => ({ topic_key: topic.topic_key, title_direction: topic.title_direction, primary_keyword: topic.primary_keyword, content_type: topic.content_type })),
  });
  const state = async (task: AgentTask) => {
    const site = await getSiteForWorkspace(env.DB, task.workspace_id, task.site_id);
    const values = Object.fromEntries((await loadTopicDecisionContext(env.DB, site!, run)).map(source => [source.sourceId, source.value]));
    const strategy = (values.active_strategies as Array<Record<string, unknown>>).find(row => row.locale === scope.locale);
    if (!strategy) throw new Error(`No active strategy for ${scope.locale}`);
    return { system_language: SYSTEM_LANGUAGE, scope, run_constraints: { ...values.run_constraints as object, source_locale: scope.locale, locales: [scope.locale] }, active_strategy: strategy };
  };
  const resolveKeyword = async (task: AgentTask, ref: string, path: Array<string | number>) => {
    const guidance = 'Select a keyword listed in this task language, by its observation_ref or its id.';
    let word: { id: string; name: string; kind: string; archived?: boolean };
    if (ref.startsWith('ref-')) {
      const observed = await resolveSlot<LibraryObservation>(env.DB, task, ref, 'keyword_library_entry', path.join('.'));
      if (observed.scope.site_id !== task.site_id || observed.scope.workspace_id !== task.workspace_id || observed.scope.locale !== libraryLocale || !observed.name) rejected('Keyword observation is outside this task language or lacks its name', path, guidance);
      word = { id: observed.id, name: observed.name!, kind: observed.kind || '' };
    } else {
      const library = new KeywordLibrary(env.DB as unknown as D1Database, { workspace_id: task.workspace_id, site_id: task.site_id, locale: scope.locale });
      word = await library.get(ref).catch(() => rejected(`Keyword ${ref} is not present in this language`, path, guidance));
    }
    if (word.kind !== 'keyword') rejected('The reference is not a keyword', path, guidance);
    if (word.archived) rejected('The keyword is archived', path, guidance);
    return word;
  };
  const toTopic = async (task: AgentTask, value: TopicInput, path: Array<string | number>): Promise<TopicDecisionItemOutput> => {
    const { keyword_ref: ref, ...content } = value;
    const word = await resolveKeyword(task, ref, [...path, 'keyword_ref']);
    return { ...content, strategy_keyword_id: word.id, keyword_id: word.id, library_keyword_id: word.id, primary_keyword: word.name, locale: scope.locale };
  };
  // Identity, scope, capacity and evidence checks run on every write; group completeness waits for submission.
  const validated = async (task: AgentTask, draft: TopicDraft) => {
    // Topic checks need topics; a description alone is already checked by its input schema.
    if (!draft.topics.length) return { accepted: true as const, draft };
    const context = { run_constraints: (await initialContext(task)).run_constraints,
      active_strategy: { keywords: draft.topics.map(topic => ({ strategy_keyword_id: topic.strategy_keyword_id, keyword_id: topic.keyword_id, term: topic.primary_keyword, locale: topic.locale })) } };
    const header = draft.group || PENDING_HEADER;
    const { rationale, ...group } = header;
    const result = topicDecisionSubmissionFeedback({ decision: { decision_type: 'topic_group', rationale, group: { ...group, items: draft.topics }, research_request: null, defer: null }, context, webEvidence: await evidence(task) });
    return result.output ? { accepted: true as const, draft: { group: draft.group, topics: result.output.group!.items } } : { accepted: false as const, feedback: result.feedback };
  };
  // A write receipt stays short however large the draft grows; read_topic_state shows the outline on demand.
  const writeDraft = (task: AgentTask, operation: TaskOperation, raw: unknown, edit: (draft: TopicDraft) => Promise<TopicDraft>) => async () => {
    await assertOpen(task);
    const resolved = await bindOperation(env.DB, task, operation, raw, async () => {
      const { revision, draft } = await readDraft(task);
      return { revision, previous: draft, next: await validated(task, await edit(draft)) };
    });
    if (!resolved.next.accepted) return { ...resolved.next.feedback, effects: 'none' };
    const next = resolved.next.draft;
    const before = new Map(resolved.previous.topics.map(topic => [topicKey(topic.topic_key), JSON.stringify(topic)]));
    const after = new Set(next.topics.map(topic => topicKey(topic.topic_key)));
    const receipt = { accepted: true, group_written: Boolean(next.group), topic_count: next.topics.length, requested_count: (await initialContext(task)).run_constraints.requested_count,
      added_topic_keys: next.topics.filter(topic => !before.has(topicKey(topic.topic_key))).map(topic => topic.topic_key),
      revised_topic_keys: next.topics.filter(topic => before.has(topicKey(topic.topic_key)) && before.get(topicKey(topic.topic_key)) !== JSON.stringify(topic)).map(topic => topic.topic_key),
      removed_topic_keys: resolved.previous.topics.filter(topic => !after.has(topicKey(topic.topic_key))).map(topic => topic.topic_key) };
    await writeTaskWorkspace(env.DB, task, operation, resolved.revision, next, receipt);
    return receipt;
  };
  const persist = async (task: AgentTask, operation: TaskOperation, output: TopicDecisionOutput) => {
    const strategy = (await initialContext(task)).active_strategy.version;
    return persistTopicDecisionResult({ db: env.DB, workspaceId: task.workspace_id, siteId: task.site_id, runId: run.id, operationId: operation.id,
      scope, strategyVersionId: strategy.id, strategyVersion: strategy.version, requestedCount: topicDecisionSummary(run).groupSize,
      locales: [scope.locale], output: aggregateLanguageTopicDecisions([{ locale: scope.locale, output }]), webEvidence: await evidence(task), searchUsed: (await evidence(task)).length > 0, decisionTurns: 0,
      languageDecisions: [{ locale: scope.locale, output, strategy }], strategyByLocale: { [scope.locale]: strategy } });
  };
  const conclusion = (task: AgentTask, operation: TaskOperation, raw: unknown, decision: (args: any) => TopicDecisionOutput) => async () => {
    await assertOpen(task);
    const { draft } = await readDraft(task);
    if (draft.topics.length) rejected(`The draft still holds ${draft.topics.length} topics`, ['topics'], 'Submit the topic group, or remove its topics before concluding without one.');
    const output = decision(raw);
    const saved = await persist(task, operation, output);
    return { accepted: true, outcome: 'submitted', decision: output.decision_type, id: saved.id, status: saved.status, rationale: output.rationale, research_request: output.research_request, defer: output.defer,
      ...(output.decision_type === 'needs_research' ? { strategy_research: task.parent_task_id ? 'Research need is reported to the requesting parent; the parent decides the next action.' : 'requested; a strategy research task starts from this request within about a minute' } : {}) };
  };

  // Before the conversation starts, wait while this language's strategy research may still rewrite the
  // library or a research request has not started it; a resumed conversation is not gated again.
  const started = await env.DB.prepare('select 1 from agent_conversations where task_id=?').bind(run.id).first();
  for (let poll = 0; !started; poll++) {
    const strategy = await unfinishedStrategyTask(env.DB, run.workspace_id, run.site_id, scope.locale);
    const request = strategy ? null : await undispatchedTopicResearchRequest(env.DB, run.workspace_id, run.site_id, scope.locale);
    if (!strategy && !request) break;
    await appendAgentEvent(env.DB, { runId: run.id, eventKey: `strategy-gate:${strategy?.id || request!.id}`, kind: 'waiting_for_strategy', phase: 'waiting_for_strategy', actorType: 'workflow',
      payload: strategy ? { strategy_task_id: strategy.id, strategy_status: strategy.status } : { research_request_id: request!.id } });
    await input.step.sleep(`strategy-gate-${poll}`, '3 minutes');
  }
  const result = await runConversationTask({ env, step: input.step, runId: run.id, definition, agent: {
    auditCompletionTools: [...SUBMIT_TOOLS],
    instructions: `${definition.mission}\n${TOPIC_LIBRARY_INSTRUCTIONS}`,
    context: async task => state(task), completionInstructions: 'Complete the decision based on persistence receipts. Submit the decision once and explicitly finish. Do not claim unsaved results.',
    tools: (task, operation) => {
      const registry = createTopicDecisionToolRegistry(env, { db: env.DB as unknown as D1Database, task: task!, operation: operation!, locales: async () => [scope.locale], sets: ['read', 'topicLinks'] }, { workspaceId: task!.workspace_id, siteId: task!.site_id, run }).mapTools(tool => {
        if (tool.name === 'read_published_articles') return { ...tool, execute: async (raw, context) => tool.execute!({ ...raw as object, locale: scope.locale }, context) };
        if (tool.name === 'topic_search_web') return { ...tool, replaySafety: 'repeatable', execute: async raw => {
          const args = topicSearchWebInputSchema.parse(raw);
          return normalizeTopicWebEvidence(await searchTaskWeb(env, run.id, args.queries, undefined, args.country))
            .map((source, index) => ({ ...source, ref: `search:${operation!.id}:${index}` }));
        } };
        return tool;
      });
      const common = { version: 1, timeoutMs: 30000, retryable: false, approval: 'never' as const, replaySafety: 'idempotent' as const, outputSchema: z.unknown() };
      const write = { ...common, capability: 'write' as const, preserveOutputSize: true };
      const topicsSchema = z.object({ topics: z.array(topicInputSchema).min(1).max(20) });
      const reviseSchema = z.object({ topic_key: z.string().trim().min(1), changes: topicChangesSchema });
      const removeSchema = z.object({ topic_keys: z.array(z.string().trim().min(1)).min(1).max(20) });
      return registry
        .register({ ...common, name: 'read_topic_state', capability: 'read',
          description: 'Read the task language, requested count, submission status and this task\'s topic draft outline: group description and each topic\'s key, title direction and keyword. Name a topic_key to read that topic in full. Use read_topic_context for business, strategy and coverage observations.',
          inputSchema: z.object({ topic_key: z.string().trim().min(1).optional() }), execute: async raw => {
            const args = raw as { topic_key?: string };
            const { draft } = await readDraft(task!);
            const context = await initialContext(task!);
            const submitted = await submission(task!);
            const topic = args.topic_key ? draft.topics.find(item => topicKey(item.topic_key) === topicKey(args.topic_key!)) : undefined;
            if (args.topic_key && !topic) rejected(`The draft has no topic ${args.topic_key}`, ['topic_key'], 'Select a topic_key from the draft outline.');
            return { system_language: SYSTEM_LANGUAGE, scope, run_constraints: context.run_constraints,
              submitted: submitted ? { tool: submitted.tool, receipt: submitted.receipt } : null, draft: outline(draft, context.run_constraints), ...(topic ? { topic } : {}) };
          } })
        .register({ ...write, name: 'write_topic_group',
          description: 'Write the complete group description of this task\'s topic draft: rationale, goal, hypothesis and expected signals, plus optional risks, unknowns and relationship to earlier groups. Rewrites the whole description and keeps every drafted topic.',
          inputSchema: groupHeaderSchema, execute: async raw => writeDraft(task!, operation!, raw, async draft => ({ ...draft, group: groupHeaderSchema.parse(raw) }))() })
        .register({ ...write, name: 'add_topics',
          description: 'Add new topics to this task\'s draft; two or three per call keeps each write short. Each topic_key must be new: use revise_topic to change a drafted topic. For web evidence select the ref handle of a topic_search_web result from this task; label internal sources by their own source_type, never "web". Keyword scope, web evidence, repeated keys and the requested count are checked for the whole draft; nothing is written when a check fails.',
          inputSchema: topicsSchema, execute: async raw => writeDraft(task!, operation!, raw, async draft => {
            const args = topicsSchema.parse(raw);
            const known = new Set(draft.topics.map(topic => topicKey(topic.topic_key)));
            args.topics.forEach((topic, index) => { if (known.has(topicKey(topic.topic_key))) rejected(`Topic ${topic.topic_key} is already drafted`, ['topics', index, 'topic_key'], 'Use revise_topic to change a drafted topic.'); });
            const added = await Promise.all(args.topics.map((topic, index) => toTopic(task!, topic, ['topics', index])));
            return { ...draft, topics: [...draft.topics, ...added] };
          })() })
        .register({ ...write, name: 'revise_topic',
          description: 'Change fields of one drafted topic selected by topic_key. Omitted fields keep their drafted values; evidence is replaced as a whole when given. topic_key itself cannot change: remove the topic and add a new one.',
          inputSchema: reviseSchema, execute: async raw => writeDraft(task!, operation!, raw, async draft => {
            const args = reviseSchema.parse(raw);
            const index = draft.topics.findIndex(topic => topicKey(topic.topic_key) === topicKey(args.topic_key));
            if (index < 0) rejected(`The draft has no topic ${args.topic_key}`, ['topic_key'], 'Select a topic_key from the draft outline.');
            const current = draft.topics[index];
            const { keyword_ref: ref, ...changes } = args.changes;
            const word = ref ? await resolveKeyword(task!, ref, ['changes', 'keyword_ref']) : null;
            const topics = [...draft.topics];
            topics[index] = { ...current, ...changes, ...(word ? { strategy_keyword_id: word.id, keyword_id: word.id, library_keyword_id: word.id, primary_keyword: word.name } : {}) };
            return { ...draft, topics };
          })() })
        .register({ ...write, name: 'remove_topics',
          description: 'Remove drafted topics selected by topic_key. Other topics and the group description are kept.',
          inputSchema: removeSchema, execute: async raw => writeDraft(task!, operation!, raw, async draft => {
            const keys = removeSchema.parse(raw).topic_keys.map(topicKey);
            keys.forEach((key, index) => { if (!draft.topics.some(topic => topicKey(topic.topic_key) === key)) rejected(`The draft has no topic ${removeSchema.parse(raw).topic_keys[index]}`, ['topic_keys', index], 'Select topic_keys from the draft outline.'); });
            return { ...draft, topics: draft.topics.filter(topic => !keys.includes(topicKey(topic.topic_key))) };
          })() })
        .register({ ...write, name: 'submit_topic_group', executionMode: 'durable_call',
          description: 'Submit this task\'s drafted topic group as its single approval batch. Requires a written group description and at least one topic; the whole group is validated and its keywords are checked again. After submission the draft is locked. Does not approve production or publication.',
          inputSchema: z.object({}), execute: async () => {
            const resolved = await bindOperation(env.DB, task!, operation!, {}, async () => {
              await assertOpen(task!);
              const { draft } = await readDraft(task!);
              if (!draft.group) rejected('The draft has no group description', ['group'], 'Write the group description with write_topic_group before submitting.');
              if (!draft.topics.length) rejected('The draft has no topics', ['topics'], 'Add topics before submitting, or conclude with request_topic_research or defer_topic_decision.');
              for (const [index, topic] of draft.topics.entries()) {
                const word = await resolveKeyword(task!, topic.library_keyword_id || topic.keyword_id, ['topics', index, 'keyword_ref']);
                if (word.name !== topic.primary_keyword) rejected(`The keyword of topic ${topic.topic_key} was renamed since it was drafted`, ['topics', index, 'keyword_ref'], 'Revise the topic with its current keyword.');
              }
              return validated(task!, draft);
            });
            if (!resolved.accepted) return { ...resolved.feedback, effects: 'none' };
            const { rationale, ...group } = resolved.draft.group!;
            const output: TopicDecisionOutput = { decision_type: 'topic_group', rationale, group: { ...group, items: resolved.draft.topics }, research_request: null, defer: null };
            const saved = await persist(task!, operation!, output);
            return { accepted: true, outcome: 'submitted', ...saved, rationale: output.rationale, topics: await materializeLibraryTopicDrafts(env.DB as unknown as D1Database, task!.workspace_id, task!.site_id, saved.id) };
          } })
        .register({ ...write, name: 'request_topic_research', executionMode: 'durable_call',
          description: 'Conclude without a topic group because a decision-blocking gap needs research, and request that research from the strategy research agent of this language. Within about a minute the request starts a strategy research task that receives your fields as its request; this task ends without waiting, and later topic decisions for this language wait until that research finishes. Allowed only while the draft holds no topics. This is the task\'s single submission.',
          inputSchema: researchSchema, execute: async raw => conclusion(task!, operation!, raw, args => {
            const { rationale, ...research_request } = researchSchema.parse(args);
            return { decision_type: 'needs_research', rationale, group: null, research_request, defer: null };
          })() })
        .register({ ...write, name: 'defer_topic_decision', executionMode: 'durable_call',
          description: 'Conclude without a topic group because topic planning should wait. Allowed only while the draft holds no topics. This is the task\'s single submission.',
          inputSchema: deferSchema, execute: async raw => conclusion(task!, operation!, raw, args => {
            const { rationale, ...defer } = deferSchema.parse(args);
            return { decision_type: 'defer', rationale, group: null, research_request: null, defer };
          })() })
        .register({ ...common, name: 'finish_topic_decision', capability: 'read', description: 'Finish after the decision was submitted, or honestly end without a deliverable.',
          inputSchema: z.object({ outcome: z.enum(['completed','partial','unable_to_complete']), reason: z.string().min(1) }),
          execute: async raw => {
            const args = raw as {outcome:string;reason:string};
            const submitted = await submission(task!);
            if (args.outcome === 'completed' && !submitted) rejected('Submit the decision before reporting completion', [], 'Inspect read_topic_state; the draft remains available.');
            return { ...(submitted?.receipt || {}), ...args, task_id: task!.id };
          }, completion: output => ({ status: 'completed', outcome: String((output as {outcome:string}).outcome), reason: String((output as {reason:string}).reason), output }) });
    },
  } });
  const current = (await taskForRun(env.DB, run.id))!;
  return { output: { ...result.output as object, task_id: current.id }, phase: result.status };
}
