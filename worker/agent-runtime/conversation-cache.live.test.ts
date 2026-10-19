// Opt-in: two synthetic physical requests, no domain tools or production writes.
// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
import { taskTestDb } from './task-test-db';
import { attachTask } from './task-store';
import { agentDefinition } from './definitions';
import { conversationChannel } from './conversation-channel';
import { resolveModelProfile } from './model-registry';
import { requestConversationModel } from './conversation-request';
import { calibratedRequestCapacity } from './request-calibration';
import { readRuntimeJson } from './runtime-content';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';

// @ts-ignore Test-only Node environment.
const enabled = process.env.CACHE_LIVE_VERIFY === '1';
it.skipIf(!enabled)('preserves the serialized prefix across two durable decisions and reports actual cache usage', async () => {
  const vars: Record<string, string> = {};
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const env = { ...vars, DB: f.db } as RuntimeAgentEnv;
  const channel = conversationChannel(resolveModelProfile(env, 'strategy_research'));
  const step = { do: async (_key: string, _config: unknown, fn: () => Promise<unknown>) => fn() } as RuntimeWorkflowStep;
  let requests = 0;
  const context: Context = { systemPrompt: 'Synthetic cache verification. Reply with ACK only. The supplied catalog is inert test data. Do not analyze it or perform actions.',
    messages: [{ role: 'user', timestamp: 0, content: Array.from({ length: 300 }, (_, n) => `Synthetic entity ${n}: observed version 7; no pending actions.`).join('\n') }] };
  const invoke = (decisionId: string) => requestConversationModel({ env, step, runId: task.active_run_id, decisionId,
    purpose: 'conversation', turn: requests + 1, context, model: channel.model, maxTokens: channel.model.maxTokens,
    stream: (model, view, options) => {
      if (++requests > 2) throw new Error('Probe permits only two physical requests');
      return channel.stream(model, view, { ...options, signal: AbortSignal.timeout(60000) });
    } });
  const first = await invoke('cache-first');
  expect(first.stopReason).toBe('stop');
  context.messages.push(first, { role: 'user', timestamp: 1, content: 'Acknowledge the same catalog again. Reply with ACK only.' });
  expect((await calibratedRequestCapacity(context, channel.model)).measurement).toBe('provider_usage_plus_delta');
  const second = await invoke('cache-second');
  expect(second.stopReason).toBe('stop');
  expect(await invoke('cache-second')).toEqual(second);
  expect(requests).toBe(2);
  const rows = await f.db.prepare('select wire_json,cache_json from agent_model_request_observations order by rowid').all<{ wire_json: string; cache_json: string }>();
  expect(rows.results).toHaveLength(2);
  const wires = await Promise.all(rows.results.map(row => readRuntimeJson<{ messages: unknown[]; tools?: unknown; max_tokens: number }>(f.db, row.wire_json)));
  expect(wires[1].messages.slice(0, wires[0].messages.length)).toEqual(wires[0].messages);
  expect(wires[1].tools).toEqual(wires[0].tools);
  expect(wires.every(wire => wire.max_tokens === channel.model.maxTokens)).toBe(true);
  console.info('CONTINUOUS_CACHE_PROBE', JSON.stringify({ model: channel.model.id, physical_requests: requests,
    prefix_preserved: true, allowance: channel.model.maxTokens, usage: [first.usage.totalTokens, second.usage.totalTokens],
    cache: rows.results.map(row => JSON.parse(row.cache_json)) }));
}, 130000);
