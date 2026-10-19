// Opt-in, bounded real-provider protocol probe. Synthetic input; no business or remote database writes.
// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runAgentLoopContinue, type AgentContext } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { conversationChannel } from './conversation-channel';
import { conversationTool } from './conversation-tools';
import { strategyTaskTools } from './strategy-task';
import { agentDefinition } from './definitions';
import { resolveModelProfile } from './model-registry';
// @ts-ignore Test-only Node environment.
const enabled = process.env.CONVERSATION_LIVE_VERIFY === '1';

it.skipIf(!enabled)('uses the real provider with production strategy reference selectors', async () => {
  const vars: Record<string, string> = {};
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  const requests: Array<Record<string, any>> = [];
  const channel = conversationChannel({ ...resolveModelProfile(vars, 'strategy_research'), maxOutputTokens: 1024 }, async (url, init) => {
      if (requests.length >= 4) throw new Error('Live probe request budget exhausted');
      requests.push(JSON.parse(String(init?.body)));
      return fetch(url, init);
    });
  const schema = strategyTaskTools({env: {} as never, definition: agentDefinition('strategy_research')}).resolve(agentDefinition('strategy_research'), 'update_strategy_keywords').inputSchema;
  const workspaceRef = 'ref-' + crypto.randomUUID();
  const keywordRef = 'ref-' + crypto.randomUUID();
  const proof = crypto.randomUUID();
  let calls = 0;
  const context: AgentContext = {
    systemPrompt: 'Synthetic contract test. Call update_strategy_keywords exactly once. Select the supplied workspace_ref and keyword_ref, patch only business_relevance to Synthetic hypothesis only. No create or remove. After the tool returns, reply with its proof value exactly.',
    messages: [{ role: 'user', content: JSON.stringify({workspace_ref: workspaceRef, keyword_ref: keywordRef}), timestamp: Date.now() }],
    tools: [conversationTool({ name: 'update_strategy_keywords', description: 'Patch the selected synthetic keyword and return a receipt proof.', inputSchema: schema }, async (_id, input) => {
      expect(input).toMatchObject({workspace_ref: workspaceRef, patch: [{keyword_ref: keywordRef, changes: {business_relevance: 'Synthetic hypothesis only'}}]});
      calls++;
      return { content: [{ type: 'text', text: JSON.stringify({ proof }) }], details: { proof } };
    })],
  };
  const ended: Message[] = [];
  await runAgentLoopContinue(context, { model: channel.model, maxTokens: 1024, convertToLlm: messages => messages as Message[],
    beforeToolCall: async () => calls >= 2 ? { block: true, terminate: true, reason: 'Probe tool budget exhausted' } : undefined,
  }, async event => { if (event.type === 'message_end') ended.push(event.message as Message); }, AbortSignal.timeout(60000), channel.stream);
  const assistant = ended.filter((m): m is Extract<Message, { role: 'assistant' }> => m.role === 'assistant');
  expect(calls).toBeGreaterThan(0);
  expect(assistant.at(-1)?.stopReason).toBe('stop');
  expect(assistant.at(-1)?.content.some(c => c.type === 'text' && c.text.includes(proof))).toBe(true);
  expect(requests.length).toBeLessThanOrEqual(4);
  expect(requests[1].messages.some((m: any) => m.role === 'tool' && String(m.content).includes(proof))).toBe(true);
  expect(requests[0].tools[0].function.parameters.properties.workspace_ref.type).toBe('string');
  expect(requests[0].tools[0].function.parameters.properties.expected_revision).toBeUndefined();
  expect(requests.every(request => request.reasoning_effort === undefined && request.reasoning === undefined)).toBe(true);
  console.info('NATIVE_PROVIDER_PROBE', JSON.stringify({ provider: channel.model.provider, model: channel.model.id, requests: requests.length, tools: calls,
    stops: assistant.map(message => message.stopReason), tokens: assistant.map(message => message.usage.totalTokens) }));
}, 70000);
