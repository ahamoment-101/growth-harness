// Explicit, isolated model evaluation. Recorded reads only; no production tools execute.
// Input is a private export of instructions, manifests, native messages and assignment.
// Usage: node scripts/verify-leader-continuity.mjs /private/tmp/leader-continuity-case.json /private/tmp/leader-continuity-results
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { z } from 'zod';

const [inputPath, outputPath, selected = 'baseline,prompt,assignment,report', reportPath, replayPath, scenario, replayThrough, contractVersion = '7'] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('Provide a private case export and output directory');
const root = resolve(outputPath);
await mkdir(root, { recursive: true });
const fixture = JSON.parse(await readFile(inputPath, 'utf8'));
const env = {};
for (const line of (await readFile('.dev.vars', 'utf8')).split('\n')) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match) env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
}
if (!env.MODEL_REGISTRY) {
  const config = await readFile('wrangler.jsonc', 'utf8');
  env.MODEL_REGISTRY = JSON.parse(config.match(/"MODEL_REGISTRY"\s*:\s*("(?:\\.|[^"\\])*")/)[1]);
}
const bundlePath = resolve('.wrangler/leader-continuity/evaluation.mjs');
await build({ stdin: { resolveDir: process.cwd(), contents: `
  export { conversationChannel } from './worker/agent-runtime/conversation-channel';
  export { resolveModelProfile } from './worker/agent-runtime/model-registry';
  export * from './worker/growth-leader/prompt';
  export { LEADER_COORDINATION_INSTRUCTIONS } from './worker/growth-leader/coordination';
  export { leaderTodoTools, LEADER_TODO_INSTRUCTIONS } from './worker/growth-leader/todo';
  export { LEADER_PROGRESS_INSTRUCTIONS, progressReviewText } from './worker/growth-leader/progress-review';
  export { leaderTools, discoverableAgents } from './worker/growth-leader/tools';
  export { leaderObservation, LEADER_EVIDENCE_INSTRUCTIONS } from './worker/growth-leader/evidence-context';
  export { leaderDeliveryView } from './worker/growth-leader/delivery-view';
  export { readSource } from './worker/lib/research/evidence';
  export { classifyToolFailure } from './worker/agent-runtime/tool-failure';
` }, bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: bundlePath });
const code = await import(pathToFileURL(bundlePath));
const profile = code.resolveModelProfile(env, 'growth_leader');
const transport = code.conversationChannel(profile);
if (selected === 'prepare') {
  console.log(JSON.stringify({ prepared: true, model: profile.model, endpoint: profile.baseUrl,
    leaderMessages: fixture.leader.messages.length, childMessages: fixture.child.messages.length,
    providerCalls: 0, productionWrites: 0 }));
  process.exit(0);
}
const clean = message => ({ ...message, ...(Array.isArray(message.content) ? { content: message.content.filter(part => part.type !== 'thinking') } : {}) });
const history = (who, through) => fixture[who].messages.filter(row => row.sequence <= through).map(row => clean(structuredClone(row.message)));
const at = (who, sequence) => fixture[who].messages.find(row => row.sequence === sequence).message;
const resultOf = message => JSON.parse(message.content.find(part => part.type === 'text').text);
const taskResult = resultOf(at('leader', 17));
const atUserTimestamp = () => at('leader', 2).timestamp;
const childSource = await readFile('worker/agent-runtime/content-parent-conversation.ts', 'utf8');
const childInstructions = childSource.match(/export const CONTENT_DELEGATION_INSTRUCTIONS = '([^']*)';/)[1];
const childCompletionDescription = childSource.match(/export const CONTENT_COMPLETION_DESCRIPTION = '([^']*)';/)[1];
if (!fixture.leader.instructions.includes(code.LEADER_PROMPT)) throw new Error('Recorded Leader prompt has a different contract');
const changedSystem = fixture.leader.instructions.replace(code.LEADER_PROMPT, code.LEADER_CONTINUITY_PROMPT)
  .replace(code.LEADER_EVENT_INSTRUCTIONS, code.LEADER_CONTINUITY_EVENT_INSTRUCTIONS);
const recordedReads = new Map();
const callArgs = new Map();
for (const { message } of fixture.leader.messages) {
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part.type === 'toolCall') callArgs.set(part.id, part.arguments);
  }
  if (message.role === 'toolResult') recordedReads.set(`${message.toolName}:${JSON.stringify(callArgs.get(message.toolCallId) || {})}`, resultOf(message));
}
function lookup(name, args) {
  const exact = recordedReads.get(`${name}:${JSON.stringify(args)}`);
  if (exact !== undefined && !(name === 'discover_agents' && Number(contractVersion) >= 8)) return structuredClone(exact);
  if (name === 'read_workspace') {
    if (args.section === 'article' && fixture.article_details) return structuredClone(fixture.article_details[args.target_ref] ?? null);
    const supplemental = fixture.extra_reads?.[`read_workspace:${args.section}`];
    if (supplemental !== undefined) return structuredClone(supplemental);
    for (const [key, value] of recordedReads) {
      if (!key.startsWith('read_workspace:')) continue;
      const saved = JSON.parse(key.slice('read_workspace:'.length));
      if (saved.section === args.section && (args.section !== 'article' || saved.target_ref === args.target_ref)) return structuredClone(value);
    }
  }
  if (name === 'discover_agents') {
    const value = structuredClone(recordedReads.get('discover_agents:{}'));
    if (Number(contractVersion) >= 8) value.agents = code.discoverableAgents(8);
    return value;
  }
  return undefined;
}
async function decision(label, turn, systemPrompt, messages, manifest) {
  if (replayPath && (!replayThrough || turn <= Number(replayThrough))) {
    try {
      const saved = JSON.parse(await readFile(`${replayPath}/${label}-${turn}-response.json`, 'utf8'));
      await writeFile(`${root}/${label}-${turn}-response.json`, JSON.stringify(saved, null, 2));
      console.log(JSON.stringify({ label, turn, replayedFrom: replayPath }));
      return saved;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let wire;
  const response = await transport.stream(transport.model, { systemPrompt, messages, tools: manifest.map(({ name, description, parameters }) => ({ name, description, parameters })) }, {
    reasoning: 'low', maxTokens: profile.maxOutputTokens,
    onPayload: value => { wire = value; },
  }).result();
  // No API key or private model reasoning is written to artifacts.
  await writeFile(`${root}/${label}-${turn}-request.json`, JSON.stringify(wire, null, 2));
  const publicResponse = clean(response);
  await writeFile(`${root}/${label}-${turn}-response.json`, JSON.stringify(publicResponse, null, 2));
  if (['error', 'aborted', 'length'].includes(response.stopReason)) throw new Error(response.errorMessage || response.stopReason);
  console.log(JSON.stringify({ label, turn, stop: response.stopReason, input: response.usage.input, cacheRead: response.usage.cacheRead,
    calls: publicResponse.content.filter(p => p.type === 'toolCall').map(p => p.name),
    text: publicResponse.content.filter(p => p.type === 'text').map(p => p.text).join('\n').slice(0, 600),
    wireHash: createHash('sha256').update(JSON.stringify(wire)).digest('hex') }));
  return publicResponse;
}

// Re-evaluate the child's actual inspection checkpoint; completion remains intercepted.
let businessReport;
const variants = selected.split(',');
function withTimeline(inspection) {
  if (!fixture.timeline) throw new Error('Current report replay requires persisted work timestamps');
  return { ...inspection, items: inspection.items.map(item => ({ ...item,
    ...fixture.timeline.items.find(row => row.job_id === item.job_id) })) };
}
if (variants.some(value => ['report', 'todo'].includes(value)) && reportPath) {
  businessReport = JSON.parse(await readFile(reportPath, 'utf8'));
  await writeFile(`${root}/child-business-report.json`, JSON.stringify(businessReport, null, 2));
} else if (variants.some(value => ['report', 'todo'].includes(value))) {
  const manifest = structuredClone(fixture.child.tools);
  const tool = manifest.find(t => t.name === 'complete_content_group');
  tool.description = childCompletionDescription;
  const anchor = 'complete_content_group requires all items ready for human publication review; it never publishes articles.';
  if (!fixture.child.instructions.includes(anchor)) throw new Error('Recorded content prompt has a different contract');
  const childMessages = history('child', 4);
  const prefix = 'Internal task trigger and trusted initial context:\n';
  if (!childMessages[0].content.startsWith(prefix)) throw new Error('Unknown initial context format');
  const initial = JSON.parse(childMessages[0].content.slice(prefix.length));
  const context = initial.sources.find(source => source.sourceId === 'content_group').value;
  const prior = context.prior_execution;
  context.group_record = { management_run_id: prior.parent_run_id, status: prior.status, error: prior.error, updated_at: prior.recorded_at };
  delete context.prior_execution;
  context.current_run.started_at = fixture.timeline.run.created_at;
  context.items = context.items.map(item => {
    const row = fixture.timeline.items.find(row => row.job_id === item.job_id);
    return { ...item, job_created_at: row.job_created_at, published_at: row.published_at };
  });
  if (initial.state) initial.state = withTimeline(initial.state);
  childMessages[0].content = prefix + JSON.stringify(initial);
  childMessages[3].content = [{ type: 'text', text: JSON.stringify(withTimeline(resultOf(childMessages[3]))) }];
  const response = await decision('child-report', 1, fixture.child.instructions.replace(anchor, `\n${childInstructions}\n${childCompletionDescription}`), childMessages, manifest);
  const completion = response.content.find(p => p.type === 'toolCall' && ['complete_content_group', 'defer_content_group'].includes(p.name));
  if (!completion) throw new Error('Child took another path; inspect the recorded response before extending this checkpoint replay');
  businessReport = { tool: completion.name, arguments: completion.arguments };
  await writeFile(`${root}/child-business-report.json`, JSON.stringify(businessReport, null, 2));
}
const summaries = [];
for (const variant of variants) {
  const withAssignment = ['assignment', 'report', 'start', 'todo'].includes(variant);
  const manifest = structuredClone(fixture.leader.tools);
  let todo = { path: 'todo.md', exists: false, markdown: '', observation_ref: 'replay-todo:0' };
  let todoRevision = 0;
  let shownTodoRevision = -1;
  if (variant === 'todo') {
    const currentTools = code.leaderTools({}, {}, { definition_version: Number(contractVersion) });
    for (const name of ['discover_agents','read_workspace','read_task','delegate_task']) {
      const tool = currentTools.resolve({ tools: currentTools.names() }, name);
      Object.assign(manifest.find(item => item.name === name), { description: tool.description, parameters: z.toJSONSchema(tool.inputSchema, { io: 'input' }) });
    }
    const registry = code.leaderTodoTools({}, {});
    for (const name of registry.names()) {
      const tool = registry.resolve({ tools: registry.names() }, name);
      manifest.push({ name, description: tool.description, parameters: z.toJSONSchema(tool.inputSchema, { io: 'input' }) });
    }
  }
  if (withAssignment) manifest.find(t => t.name === 'read_task').description = 'Read a scoped task together with its saved assignment, status and delivered outcome. Relate this reply to the original delegation and the user request in your conversation. Does not expose specialist conversations.';
  const report = structuredClone(taskResult);
  if (withAssignment) report.assignment = fixture.assignment;
  if (['report', 'todo'].includes(variant)) {
    report.result.state = withTimeline(report.result.state);
    report.result.judgment_summary = businessReport.arguments.judgment_summary;
    if (businessReport.tool === 'complete_content_group') {
      report.reason = businessReport.arguments.judgment_summary;
      report.result.outcome = 'completed';
    }
    else {
      report.status = 'waiting'; report.reason = businessReport.arguments.reason;
      report.result = { ...businessReport.arguments, group_id: report.result.group_id };
    }
  }
  // Resume immediately after read_task returned, keeping the complete preceding history.
  const messages = history('leader', variant === 'start' || scenario === 'dialogue' ? 2 : 17);
  const dialogueInputs = [
    'Don\'t execute yet. I want to understand: how do you divide work with the content team?',
    'We\'re still just discussing. If the article the team produced was already published, how should you judge whether this task is complete?',
    'Now start executing: produce the next batch of new content for this site, two pieces in total.',
  ];
  let dialogueIndex = 0;
  if (scenario === 'dialogue') messages[1].content = dialogueInputs[0];
  if (variant !== 'baseline') {
    const user = messages[1];
    user.content = `Conversation input: ${JSON.stringify({ kind: 'user', input_ref: fixture.extra_reads['read_workspace:business'].user_messages[0].id, received_at: new Date(user.timestamp).toISOString() })}\n${user.content}`;
  }
  if (variant !== 'start' && scenario !== 'dialogue') messages.at(-1).content = [{ type: 'text', text: JSON.stringify(variant === 'todo' ? code.leaderObservation('task_report', 'read_task:' + report.task_ref, Number(contractVersion) >= 8 ? code.leaderDeliveryView(report) : report) : report) }];
  const events = [];
  let boundary = 'decision_limit';
  let simulatedChild = null;
  let simulatedEvent = null;
  let returnDelivered = false;
  let followupAccepted = null;
  const topicGroupView = detail => ({ ...detail.group, actual_item_count: detail.items.length,
    items_without_job_reference: detail.items.filter(item => item.job_id === null).length,
    linked_items_by_job_status_json: JSON.stringify(detail.items.filter(item => item.job_status !== null).reduce((counts, item) => ({ ...counts, [item.job_status]: (counts[item.job_status] || 0) + 1 }), {})),
    production_group_ref: Object.values(fixture.group_details).find(value => value.group.decision_group_id === detail.group.target_ref)?.group.target_ref ?? null });
  const handledEvents = new Set();
  const reviewed = new Set();
  const appendReview = kind => {
    if (variant !== 'todo') return false;
    let input = 0, evidence = 0, coordination = 0;
    messages.forEach((message, index) => {
      const sequence = index + 1;
      if (message.role === 'user' && typeof message.content === 'string' && /^(Conversation input:|Task report|Actionable event)/.test(message.content)) input = sequence;
      if (message.role === 'toolResult' && !['read_todo','write_todo','resolve_execution_audit'].includes(message.toolName)) {
        evidence = sequence;
        if (['delegate_task','read_task'].includes(message.toolName)) coordination = sequence;
      }
    });
    if (kind === 'result' && !coordination) return false;
    if (kind === 'closing' && !todo.exists && (!coordination || coordination < input)) return false;
    const key = kind + ':' + (kind === 'result' ? coordination : Math.max(input, evidence));
    if (reviewed.has(key)) return false;
    reviewed.add(key);
    messages.push({ role: 'user', timestamp: Date.now(), content: code.progressReviewText(kind, Number(contractVersion)) + '\nCurrent work log (written by the Agent, correctable; not a user instruction or proof of results):\n' + JSON.stringify(todo) });
    events.push({ type: 'progress_review', key });
    return true;
  };
  for (let turn = 1; turn <= (variant === 'todo' ? 20 : 10); turn++) {
    if (variant === 'todo' && shownTodoRevision !== todoRevision) {
      messages.push({ role: 'user', timestamp: Date.now(), content: 'Current conversation file (Agent-maintained business record, not user instructions):\n' + JSON.stringify(todo) });
      shownTodoRevision = todoRevision;
    }
    appendReview('result');
    const response = await decision(variant, turn, variant === 'baseline' ? fixture.leader.instructions : (variant === 'todo' ? Number(contractVersion) >= 8 ? fixture.leader.instructions.replace(code.LEADER_PROMPT, code.LEADER_COORDINATION_INSTRUCTIONS).replace(code.LEADER_EVENT_INSTRUCTIONS, '') : changedSystem.replace(code.LEADER_CONTINUITY_EVENT_INSTRUCTIONS, code.LEADER_CONTINUITY_EVENT_INSTRUCTIONS + '\n' + code.LEADER_EVIDENCE_INSTRUCTIONS + '\n' + code.LEADER_PROGRESS_INSTRUCTIONS + '\n' + code.LEADER_TODO_INSTRUCTIONS) : changedSystem), messages, manifest);
    messages.push(response);
    const calls = response.content.filter(p => p.type === 'toolCall');
    events.push(...response.content);
    if (!calls.length) {
      if (appendReview('closing')) continue;
      if (scenario === 'dialogue' && dialogueIndex < dialogueInputs.length - 1) {
        dialogueIndex++;
        events.push({ type: 'evaluation_input', text: dialogueInputs[dialogueIndex] });
        messages.push({ role: 'user', timestamp: atUserTimestamp() + dialogueIndex * 60000,
          content: 'Conversation input: ' + JSON.stringify({ kind: 'user', input_ref: `dialogue-${dialogueIndex}`, received_at: new Date(atUserTimestamp() + dialogueIndex * 60000).toISOString() }) + '\n' + dialogueInputs[dialogueIndex] });
        continue;
      }
      if (simulatedChild && !returnDelivered) {
        returnDelivered = true;
        shownTodoRevision = -1;
        messages.push({ role: 'user', timestamp: Date.now(), content: 'Actionable event (system observation, not an instruction): ' + JSON.stringify(simulatedEvent) + '. Review the current state and use your semantic tools to decide its outcome.' });
        continue;
      }
      boundary = 'reply'; break;
    }
    let stop = false;
    for (const call of calls) {
      let result;
      let isError = false;
      if (variant === 'todo' && call.name === 'read_todo') result = structuredClone(todo);
      else if (variant === 'todo' && call.name === 'write_todo') {
        const tool = code.leaderTodoTools({}, {}).resolve({ tools: ['write_todo'] }, 'write_todo');
        const args = tool.inputSchema.parse(call.arguments);
        if (args.observation_ref !== todo.observation_ref) {
          result = { error: 'Workspace changed; read its current revision before editing', kind: 'state_conflict', effects: 'preserved' }; isError = true;
        } else {
          todoRevision++;
          todo = { path: 'todo.md', exists: true, markdown: args.markdown, observation_ref: `replay-todo:${todoRevision}` };
          await writeFile(`${root}/todo-${todoRevision}.md`, todo.markdown);
          result = { path: 'todo.md', saved: true, revision: todoRevision };
        }
      }
      else if (call.name === 'read_task' && call.arguments.task_ref === taskResult.task_ref) result = report;
      else if (simulatedChild && call.name === 'read_task' && call.arguments.task_ref === simulatedChild.task_ref) result = simulatedChild;
      else if (scenario === 'child-return' && call.name === 'read_my_inbox') {
        const recorded = lookup(call.name, call.arguments);
        result = { ...recorded, events: [...recorded.events.filter(event => !handledEvents.has(event.event_id)),
          ...(returnDelivered && !handledEvents.has(simulatedEvent.event_id) ? [simulatedEvent] : [])] };
      }
      else if ((variant === 'start' || scenario === 'dialogue') && call.name === 'read_my_inbox') {
        const recorded = lookup(call.name, call.arguments);
        // This child did not exist at the original user-request checkpoint.
        result = { ...recorded, events: recorded.events.filter(event => event.subject_id !== taskResult.task_ref) };
      }
      else if (variant === 'todo' && call.name === 'read_workspace' && call.arguments.section === 'topic_groups') {
        if (!fixture.topic_details) throw new Error('Missing real topic snapshot');
        const offset = call.arguments.offset || 0;
        if (call.arguments.target_ref) {
          const detail = fixture.topic_details[call.arguments.target_ref];
          if (!detail) { result = { error: 'Topic group not found in this site', kind: 'invalid_request', effects: 'none' }; isError = true; }
          else result = { group: topicGroupView(detail), items: detail.items.slice(offset, offset + 50), next_offset: offset + 50 < detail.items.length ? offset + 50 : null };
        } else {
          const groups = Object.values(fixture.topic_details).map(detail => (topicGroupView(detail)));
          result = { groups: groups.slice(offset, offset + 50), next_offset: offset + 50 < groups.length ? offset + 50 : null };
        }
      }
      else if (['report', 'start', 'todo'].includes(variant) && call.name === 'read_workspace' && call.arguments.section === 'content_groups' && call.arguments.target_ref) {
        result = fixture.group_details?.[call.arguments.target_ref];
        if (!result) { result = { error: 'Content group not found in this site', kind: 'invalid_request', effects: 'none', issues: [], guidance: 'Read current scoped references and use a supported action.' }; isError = true; }
      }
      else if (call.name === 'read_workspace' && call.arguments.section === 'source' && fixture.extra_reads['read_workspace:business'].sources.length === 0) {
        // Execute the real domain reader against the recorded empty source index.
        // This models its actual validation error, not a fabricated missing article.
        const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) };
        try { await code.readSource({ DB: db }, { id: 'replay', workspace_id: 'replay', site_id: 'replay' }, call.arguments.source_ref || ''); }
        catch (error) { result = { error: error.message, ...code.classifyToolFailure(error) }; isError = true; }
      }
      else if (call.name === 'complete_inbox_event') {
        handledEvents.add(call.arguments.event_ref);
        result = { event_ref: call.arguments.event_ref, completed: true };
      }
      else if (call.name === 'delegate_task' && call.arguments.agent_ref === 'content_production' && !fixture.group_details?.[call.arguments.target_ref]) {
        result = { error: 'Use an existing approved production group; topic approval creates the group', kind: 'invalid_request', effects: 'none', issues: [], guidance: 'Read current scoped references and use a supported action.' }; isError = true;
      }
      else if (scenario === 'child-return' && !simulatedChild && call.name === 'delegate_task' && call.arguments.agent_ref === 'content_production' && fixture.group_details?.[call.arguments.target_ref]) {
        // Controlled follow-up: simulate inspection-only completion using actual saved
        // group/job facts. No content Agent or production action executes here.
        const detail = fixture.group_details[call.arguments.target_ref];
        const at = new Date(atUserTimestamp() + 180000).toISOString();
        simulatedChild = { task_ref: 'replay-inspection-child', agent: 'content_production', status: 'completed', reason: 'Content group inspection completed.',
          assignment: { id: 'replay-inspection-assignment', created_at: at,
            material: { goal: call.arguments.goal, reason: call.arguments.reason, context: call.arguments.context } },
          result: { group_id: call.arguments.target_ref, outcome: 'completed', actions_executed: ['inspect_content_group'],
            state: { group: detail.group, items: detail.items.map(item => ({ job_id: item.job_ref, job_status: item.status,
              title_direction: item.title_direction, job_created_at: item.created_at, published_at: item.published_at })) } } };
        simulatedEvent = { event_id: 'replay-inspection-report', type: 'agent.task_report_ready', subject_id: simulatedChild.task_ref,
          source_ref: taskResult.task_ref, summary: 'content_production completed', available_at: at, status: 'pending' };
        await writeFile(`${root}/simulated-child-report.json`, JSON.stringify({ provenance: 'Controlled inspection-only child return. Actual saved group/job facts; no live child execution.', report: simulatedChild }, null, 2));
        result = { task_ref: simulatedChild.task_ref, status: 'running', accepted: true, result_delivery: 'this_conversation' };
      }
      else if (scenario === 'child-return' && !followupAccepted && call.name === 'delegate_task' && call.arguments.agent_ref === 'topic_decision') {
        const discovery = lookup('discover_agents', {});
        if (!discovery.scopes.some(scope => scope.scope_ref === call.arguments.scope_ref)) {
          // Exact invalid-reference feedback from parameter-slots.ts; no dispatch.
          result = { error: 'Unknown, out-of-scope or wrong-type reference', kind: 'invalid_request', effects: 'none',
            issues: [{ path: ['leader_scope'], message: 'Unknown, out-of-scope or wrong-type reference' }],
            guidance: 'Read the available references and select an existing reference of the required type. Do not reconstruct identities or versions.' };
          isError = true;
        } else if (!call.arguments.market) {
          result = { error: 'Choose a market for this topic task', kind: 'invalid_request', effects: 'none' }; isError = true;
        } else {
          followupAccepted = call.arguments;
          result = { task_ref: 'replay-topic-child', status: 'running', accepted: true, result_delivery: 'this_conversation' };
          await writeFile(`${root}/simulated-followup-acceptance.json`, JSON.stringify({ provenance: 'Dispatch receipt simulated after checking known scope reference and market; no actual topic task created.', assignment: followupAccepted }, null, 2));
        }
      }
      else if (['delegate_task','request_human_input','decide_publication','create_conversation','resolve_execution_audit'].includes(call.name)) {
        boundary = call.name; stop = true; continue;
      } else result = lookup(call.name, call.arguments);
      if (result === undefined) { boundary = `unrecorded_read:${call.name}`; stop = true; continue; }
      if (variant === 'todo' && !isError && ['read_workspace','read_task'].includes(call.name)) result = code.leaderObservation(call.name === 'read_task' ? 'task_report' : 'workspace_records', `${call.name}:${call.arguments.section || call.arguments.task_ref}:${call.arguments.target_ref || 'list'}:offset=${call.arguments.offset || 0}`, call.name === 'read_task' && Number(contractVersion) >= 8 ? code.leaderDeliveryView(result) : result, fixture.topic_observed_at);
      if (variant === 'todo' && call.name === 'delegate_task' && result?.accepted) Object.assign(result, { receipt_kind: 'delegation_accepted', meaning: 'Work accepted; no completed business outcome is established by this receipt.' });
      messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: JSON.stringify(result) }], isError, timestamp: Date.now() });
    }
    if (!stop && scenario === 'dialogue' && dialogueIndex === dialogueInputs.length - 1) { boundary = 'execution_started'; stop = true; }
    if (stop) break;
  }
  const summary = { variant, boundary, events, model: profile.model, scenario: scenario || 'checkpoint', dialogueIndex: scenario === 'dialogue' ? dialogueIndex : undefined, simulatedChildReturn: returnDelivered, simulatedFollowupAccepted: followupAccepted,
    scope: 'Real model and production native transcript replay; recorded reads; acknowledgement simulated; all business actions intercepted before execution.' };
  summaries.push(summary);
  await writeFile(`${root}/${variant}-messages.json`, JSON.stringify(messages, null, 2));
  await writeFile(`${root}/${variant}-summary.json`, JSON.stringify(summary, null, 2));
}
await writeFile(`${root}/summary.json`, JSON.stringify(summaries, null, 2));
console.log(JSON.stringify({ results: root, variants: summaries.map(({ variant, boundary }) => ({ variant, boundary })) }));
