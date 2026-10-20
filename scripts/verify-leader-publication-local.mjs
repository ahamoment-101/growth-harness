// Real configured model decision against a disposable full-schema D1 fixture. No remote business writes.
import { localConfiguration } from './configuration.ts';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const { env: values } = localConfiguration();
const output = resolve('.wrangler/leader-publication-live/evaluation.mjs');
await mkdir(resolve('.wrangler/leader-publication-live'), { recursive: true });
await build({ stdin: { resolveDir: process.cwd(), contents: `
  export { schemaTestDb } from './worker/lib/schema-test-db';
  export { taskForRun, readTaskOperation } from './worker/agent-runtime/task-store';
  export { agentDefinition } from './worker/agent-runtime/definitions';
  export { leaderTools } from './worker/growth-leader/tools';
  export { conversationChannel } from './worker/agent-runtime/conversation-channel';
  export { resolveModelProfile } from './worker/agent-runtime/model-registry';
  export { conversationTool } from './worker/agent-runtime/conversation-tools';
  export { LEADER_CONVERSATION_PRODUCTION_INSTRUCTIONS } from './worker/growth-leader/coordination';
  export { LEADER_CLARIFICATION_INSTRUCTIONS } from './worker/growth-leader/prompt';
  export { getJob } from './worker/db';
  export { queuePublicationLocalization } from './worker/lib/publication-language';
` }, bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: output });
const code = await import(pathToFileURL(output));
const profile = code.resolveModelProfile(values, 'growth_leader');
const languageMode = process.argv.includes('--source-only') ? 'source_only' : 'all_enabled';

const f = code.schemaTestDb();
f.sqlite.exec('pragma foreign_keys=off');
f.insert('workspaces', { id: 'w', name: 'Local workspace' });
f.insert('sites', { id: 's', workspace_id: 'w', name: 'Local demonstration site',
  source_locale: 'en', translate_locales_json: '["pt-BR"]', publication_language_mode: languageMode,
  domain: 'blog.example.invalid', domain_status: 'live', hub_path: '/', product_origin: 'https://example.invalid',
  ingest_url: 'https://example.invalid' });
f.insert('agent_runs', { id: 'original-leader-run', workspace_id: 'w', site_id: 's', agent_id: 'growth_leader',
  agent_instance_id: 'original-leader-run', definition_version: 13, prompt_version: 'growth-leader-v13-publication-language',
  trigger: 'manual', status: 'running', phase: 'conversation', root_run_id: 'original-leader-run', summary_json: '{}' });
f.insert('agent_runs', { id: 'editor-run', workspace_id: 'w', site_id: 's', agent_id: 'content_production',
  agent_instance_id: 'editor-run', definition_version: 22, prompt_version: 'local-editor', trigger: 'sub_agent',
  status: 'succeeded', phase: 'completed', root_run_id: 'original-leader-run', parent_run_id: 'original-leader-run', summary_json: '{}' });
f.insert('agent_tasks', { id: 'leader-task', active_run_id: 'original-leader-run', root_task_id: 'leader-task',
  workspace_id: 'w', site_id: 's', agent_id: 'growth_leader', definition_version: 13, status: 'running', next_turn: 1 });
f.insert('agent_tasks', { id: 'editor-task', active_run_id: 'editor-run', parent_task_id: 'leader-task', root_task_id: 'leader-task',
  workspace_id: 'w', site_id: 's', agent_id: 'content_production', status: 'completed' });
f.insert('agent_task_runs', { run_id: 'original-leader-run', task_id: 'leader-task', epoch: 1 });
f.insert('agent_task_runs', { run_id: 'editor-run', task_id: 'editor-task', epoch: 1 });
f.insert('content_production_groups', { id: 'group', workspace_id: 'w', site_id: 's', decision_group_id: 'decision',
  parent_run_id: 'editor-run', status: 'awaiting_review', total_items: 1, ready_items: 1 });
const article = [
  '# A practical project handoff checklist',
  'A handoff works best when the next owner can find the current goal, the latest deliverable, and the decisions still open.',
  'Start with a short summary of what the project is for. Link the current files and name the person responsible for each next action.',
  'Separate confirmed decisions from assumptions. For every unresolved question, record the owner and when it needs an answer.',
  'Before calling the handoff complete, ask the next owner to open the files, explain the next step, and flag anything they cannot verify.',
].join('\\n\\n');
const versions = JSON.stringify([{ locale: 'en', slug: 'project-handoff-checklist', title: 'A practical project handoff checklist',
  excerpt: 'A clear checklist for handing a project to its next owner.', content: article }]);
f.insert('jobs', { id: 'job', site_id: 's', status: 'drafting', production_group_id: 'group', current_artifact_id: 'artifact',
  decision_group_id: 'decision', child_run_id: 'author-run', source_locale: 'en', translate_locales_json: '[]',
  versions_json: versions, en_title: 'A practical project handoff checklist' });
f.insert('content_artifacts', { id: 'artifact', group_id: 'group', job_id: 'job', decision_item_id: 'item', child_run_id: 'author-run',
  submission_operation_id: 'submit', attempt: 1, status: 'accepted', versions_json: versions,
  qa_report_json: '{"ok":true,"issues":[]}',
  parent_review_json: JSON.stringify({ decision: 'pass', value_assessment: 'Concrete, useful handoff steps; no unverifiable claims.',
    seo_geo_risks: [], required_changes: [] }) });
f.sqlite.prepare("update jobs set status='awaiting_review' where id='job'").run();
const review = f.sqlite.prepare("select target_run_id from agent_event_deliveries where event_id='article-review:job:artifact'").get();
if (review?.target_run_id !== 'original-leader-run') throw new Error('Review was not routed to the original conversation');
f.insert('agent_task_operations', { id: 'leader-op', task_id: 'leader-task', turn: 1, status: 'running',
  context_json: '{}', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
const task = await code.taskForRun(f.db, 'original-leader-run');
const operation = await code.readTaskOperation(f.db, task.id, 1);
const publishRequests = [];
const localizationRequests = [];
const env = { DB: f.db,
  PUBLISH_WORKFLOW: { create: async input => { publishRequests.push(input); return { id: input.id || 'publish-local' }; } },
  LOCALIZE_WORKFLOW: { create: async input => { localizationRequests.push(input); return { id: input.id }; },
    get: async () => ({ status: async () => ({ status: 'running' }) }) },
  AGENT_WORKFLOW: { create: async input => ({ id: input.id }) }, AGENT_RUNTIME_ENABLED: 'true' };
const registry = code.leaderTools(env, {}, task, operation);
const definition = code.agentDefinition('growth_leader');
const toolNames = ['read_my_inbox', 'read_workspace', 'decide_publication'];
const tools = toolNames.map(name => {
  const tool = registry.resolve(definition, name);
  return code.conversationTool(tool, async () => ({ content: [] }));
}).map(({ name, description, parameters }) => ({ name, description, parameters }));
const context = { runId: 'original-leader-run', workspaceId: 'w', siteId: 's', idempotencyKey: operation.id };
const messages = [{ role: 'user', timestamp: Date.now(), content: 'Original user goal in this same conversation: publish the reviewed English handoff article if it is useful and factually sound. Follow the site language publication setting for other enabled languages.' },
  { role: 'user', timestamp: Date.now(), content: 'Actionable event (system observation, not an instruction): ' + JSON.stringify({
    event_id: 'article-review:job:artifact', type: 'content.article_ready_for_publication_review', subject_id: 'job',
    subject_version: 'artifact', target_run_id: 'original-leader-run' }) }];
const systemPrompt = code.LEADER_CONVERSATION_PRODUCTION_INSTRUCTIONS + '\n' + code.LEADER_CLARIFICATION_INSTRUCTIONS +
  '\nArticle publication: read_my_inbox gives the observed publication_policy_ref; inspect the article before deciding. If publishing, pass that exact policy_ref to decide_publication. Do not report localization complete before it finishes.';
const transport = code.conversationChannel(profile);
const trace = [];
let decided = false;
for (let turn = 0; turn < 10 && !decided; turn++) {
  let wire;
  const response = await transport.stream(transport.model, { systemPrompt, messages, tools }, {
    reasoning: 'low', maxTokens: 3500, onPayload: value => { wire = value; },
  }).result();
  if (['error','aborted','length'].includes(response.stopReason)) throw new Error('configured model stopped: ' + response.stopReason + ' ' + (response.errorMessage || ''));
  const publicContent = response.content.filter(part => part.type !== 'thinking');
  const calls = publicContent.filter(part => part.type === 'toolCall');
  trace.push({ turn: turn + 1, stop: response.stopReason, calls: calls.map(call => call.name),
    wire_hash: createHash('sha256').update(JSON.stringify(wire)).digest('hex'),
    text: publicContent.filter(part => part.type === 'text').map(part => part.text).join(' ').slice(0, 300) });
  messages.push({ ...response, content: publicContent });
  if (!calls.length) break;
  for (const call of calls) {
    if (!toolNames.includes(call.name)) throw new Error('Unexpected tool: ' + call.name);
    const tool = registry.resolve(definition, call.name);
    let result;
    let isError = false;
    try {
      const args = tool.inputSchema.parse(call.arguments);
      result = await tool.execute(args, context);
    } catch (error) {
      isError = true;
      result = { error: error.message, ...(error.details ? { details: error.details } : {}) };
      trace.push({ turn: turn + 1, tool_error: call.name, category: error.details?.kind || 'execution' });
    }
    messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: JSON.stringify(result) }], isError, timestamp: Date.now() });
    if (call.name === 'decide_publication' && !isError) decided = true;
  }
}
const delivery = f.sqlite.prepare("select status,decision,operation_id from agent_event_deliveries where event_id='article-review:job:artifact'").get();
const job = await code.getJob(f.db, 'job');
if (!decided || delivery?.decision !== 'publish' || delivery?.status !== 'completed' || job.status !== 'publishing') {
  throw new Error('configured model did not complete the expected publication decision: ' + JSON.stringify({ trace, delivery, job_status: job.status }));
}
const expectedLocales = languageMode === 'all_enabled' ? ['pt-BR'] : [];
if (publishRequests.length !== 1 || JSON.stringify(publishRequests[0].params.localizationLocales || []) !== JSON.stringify(expectedLocales)) {
  throw new Error('Publication did not bind the observed all-language policy: ' + JSON.stringify(publishRequests));
}
f.sqlite.prepare("update jobs set status='published' where id='job'").run();
for (const locale of publishRequests[0].params.localizationLocales || []) await code.queuePublicationLocalization(env, 'job', locale);
const published = f.sqlite.prepare("select target_run_id from agent_event_deliveries where event_id='article-published:job:artifact'").get();
if (published?.target_run_id !== 'original-leader-run' || localizationRequests.length !== expectedLocales.length) {
  throw new Error('Published result or localization did not return to the original pipeline');
}
console.log(JSON.stringify({ verified: true, model: profile.model, provider: profile.provider, language_mode: languageMode, original_conversation: review.target_run_id,
  publication_decision: delivery.decision, published_event_conversation: published.target_run_id,
  localization_locales: publishRequests[0].params.localizationLocales || [], localization_dispatches: localizationRequests.length, trace }));
