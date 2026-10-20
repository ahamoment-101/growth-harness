// Opt-in synthetic provider request. No business tools or production data writes.
import { localConfiguration } from '../../scripts/configuration';
import { expect, it } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { taskTestDb } from './task-test-db';
import { attachTask } from './task-store';
import { agentDefinition } from './definitions';
import { conversationChannel } from './conversation-channel';
import { resolveModelProfile } from './model-registry';
import { summarizeDurably } from './summary-request';
import { readRuntimeJson } from './runtime-content';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';

// @ts-ignore Node test environment.
const enabled = process.env.SUMMARY_LIVE_VERIFY === '1';
it.skipIf(!enabled)('persists a real complete summary with exact references and reuses the response', async () => {
  const { env: vars } = localConfiguration();
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  const env = { ...vars, DB: f.db } as RuntimeAgentEnv;
  const channel = conversationChannel(resolveModelProfile(env, 'strategy_research'));
  let physicalRequests = 0;
  const stream: StreamFn = (model, context, options) => {
    if (++physicalRequests > 1) throw new Error('Synthetic summary probe permits one physical request');
    return channel.stream(model, context, { ...options, signal: AbortSignal.timeout(60000) });
  };
  const reference = `candidate-${crypto.randomUUID()}`;
  const input = { env, step: { do: async (_key: string, _config: unknown, fn: () => Promise<unknown>) => fn() } as RuntimeWorkflowStep,
    runId: task.active_run_id, key: 'live-summary', turn: 1, model: channel.model, stream,
    instructions: 'Summarize this synthetic task in under 150 words. Keep the exact candidate reference and observed version, completed effects, unresolved failure and next action. Do not invent completion.',
    material: `Goal: review a candidate. Candidate reference: ${reference}. Observed version: 7. Saving the candidate succeeded. Review did not execute because the external service was unavailable. Next: review the same observed candidate version. No publication occurred.` };
  const summary = await summarizeDurably(input);
  expect(summary).toContain(reference);
  expect(summary).toContain('7');
  expect(await summarizeDurably(input)).toBe(summary);
  expect(physicalRequests).toBe(1);
  const row = await f.db.prepare('select wire_json,cache_json from agent_model_request_observations').first<{wire_json:string;cache_json:string}>();
  expect(row).not.toBeNull();
  const wire = await readRuntimeJson<Record<string, unknown>>(f.db, row!.wire_json);
  expect(wire.max_tokens).toBe(channel.model.maxTokens);
  console.info('DURABLE_SUMMARY_PROBE', JSON.stringify({ model: channel.model.id, max_tokens: wire.max_tokens,
    physical_requests: physicalRequests, reference_preserved: true, cache: JSON.parse(row!.cache_json) }));
}, 70000);
