// Opt-in, bounded real-provider protocol probe. Synthetic input; no business or remote database writes.
// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runAgentLoop, runAgentLoopContinue, type AgentContext } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { conversationChannel } from './conversation-channel';
import { conversationTool } from './conversation-tools';
import { z } from 'zod';
import { resolveModelProfile } from './model-registry';
// @ts-ignore Test-only Node environment.
const enabled = process.env.CONVERSATION_LIVE_VERIFY === '1';

it.skipIf(!enabled)('uses the real provider to call the research finding schema and observe the native result', async () => {
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
  const schema = z.object({ findings: z.array(z.object({ claim: z.string(), kind: z.enum(['fact','inference','uncertain']), evidence: z.array(z.object({ source_id: z.string(), quote: z.string() })) })) });
  const proof = crypto.randomUUID();
  let calls = 0;
  const context: AgentContext = {
    systemPrompt: 'This is a synthetic transport test. First call save_test_findings to record one uncertain finding, claim "Synthetic hypothesis only", with evidence []. Omit id when creating. After the tool returns a receipt, reply with its proof value exactly. Do not search or claim real facts.',
    messages: [{ role: 'user', content: 'Run the synthetic finding test, then report the tool receipt proof.', timestamp: Date.now() }],
    tools: [conversationTool({ name: 'save_test_findings', description: 'Save a synthetic finding and return a receipt proof.', inputSchema: schema }, async (_id, input) => {
      expect(input).toMatchObject({ findings: [{ claim: 'Synthetic hypothesis only', kind: 'uncertain', evidence: [] }] });
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
  expect(JSON.stringify(requests[1])).toContain(proof);
  const toolSchema = requests[0].tools[0].function?.parameters || requests[0].tools[0].parameters || requests[0].tools[0].input_schema;
  expect(toolSchema.properties.findings.items.properties.evidence.type).toBe('array');
  // Reasoning parameters follow the selected model capabilities, not a fixed vendor assumption.
  console.info('NATIVE_PROVIDER_PROBE', JSON.stringify({ provider: channel.model.provider, model: channel.model.id, requests: requests.length, tools: calls,
    stops: assistant.map(message => message.stopReason), tokens: assistant.map(message => message.usage.totalTokens) }));
}, 70000);

it.skipIf(!enabled)('accepts an assistant-tail continuation and serializes the configured generation allowance', async () => {
  const vars: Record<string, string> = {};
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  const requests: Array<Record<string, any>> = [];
  const channel = conversationChannel({ ...resolveModelProfile(vars), maxOutputTokens: 32000 }, async (url, init) => {
      if (requests.length) throw new Error('Only one physical request is authorized for this probe');
      requests.push(JSON.parse(String(init?.body)));
      return fetch(url, init);
    });
  const context: AgentContext = { systemPrompt: 'Synthetic protocol test. Your next response must be the text READY. No tools or external actions.', tools: [],
    messages: [{ role: 'user', content: 'Acknowledge the protocol.', timestamp: 0 },
      { role: 'assistant', api: channel.model.api, provider: channel.model.provider, model: channel.model.id,
        content: [{ type: 'text', text: 'Acknowledged.' }], timestamp: 0, stopReason: 'stop',
        usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] };
  const messages = await runAgentLoop([], context, { model: channel.model, maxTokens: channel.model.maxTokens,
    shouldStopAfterTurn: () => true, convertToLlm: messages => messages as Message[] }, () => {},
    AbortSignal.timeout(60000), channel.stream);
  const response = messages.find((message): message is Extract<Message, { role: 'assistant' }> => message.role === 'assistant');
  expect(requests).toHaveLength(1);
  expect(requests[0].max_tokens).toBe(32000);
  expect(requests[0].messages.at(-1).role).toBe('assistant');
  if (response?.errorMessage) {
    let error = response.errorMessage;
    for (const [key, value] of Object.entries(vars)) if (/KEY|TOKEN|SECRET/.test(key) && value) error = error.replaceAll(value, '[redacted]');
    console.info('ASSISTANT_TAIL_ERROR', error.slice(0, 1000));
  }
  expect(response?.stopReason).toBe('stop');
  expect(response?.content.some(part => part.type === 'text' && part.text.includes('READY'))).toBe(true);
  console.info('ASSISTANT_TAIL_PROBE', JSON.stringify({ model: channel.model.id, allowance: requests[0].max_tokens,
    stop: response?.stopReason, usage: response?.usage.totalTokens }));
}, 70000);
