// Opt-in paid protocol probes. Synthetic input only; no business or database writes.
// @ts-ignore Test-only Node API.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { runtimeChannelModel } from './model-policy';
import { resolveModelProfile } from './model-registry';
import type { AgentId } from './definitions';

const enabled = process.env.CONTENT_MODELS_LIVE_VERIFY === '1';

function liveEnv(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return vars;
}

async function probe(agentId: AgentId) {
  const profile = resolveModelProfile(liveEnv(), agentId);
  const result = await generateText({
    model: runtimeChannelModel(profile),
    prompt: 'Call finish_probe exactly once with outcome ready.',
    maxOutputTokens: 512,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(60_000),
    toolChoice: 'required',
    tools: {
      finish_probe: tool({
        description: 'Finish this synthetic transport probe.',
        inputSchema: z.object({ outcome: z.literal('ready') }),
      }),
    },
  });
  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls[0]).toMatchObject({ toolName: 'finish_probe', input: { outcome: 'ready' } });
  expect(result.response.id).toBeTruthy();
  return { provider: profile.provider, model: profile.model, requestId: result.response.id };
}

it.skipIf(!enabled)('calls the configured editor connection with the parent decision protocol', async () => {
  console.info('CONTENT_MODEL_PROBE', await probe('content_production'));
}, 70_000);

it.skipIf(!enabled)('calls the configured writer connection with the author tool protocol', async () => {
  console.info('CONTENT_MODEL_PROBE', await probe('article_production'));
}, 70_000);
