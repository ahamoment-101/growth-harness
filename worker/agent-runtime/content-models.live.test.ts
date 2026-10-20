// Opt-in paid protocol probes. Synthetic input only; no business or database writes.
import { localConfiguration } from '../../scripts/configuration';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { conversationChannel } from './conversation-channel';
import { conversationTool } from './conversation-tools';
import { resolveModelProfile } from './model-registry';
import type { AgentId } from './definitions';

const enabled = process.env.CONTENT_MODELS_LIVE_VERIFY === '1';

async function probe(agentId: AgentId) {
  const profile = resolveModelProfile(localConfiguration().env, agentId);
  const channel = conversationChannel(profile);
  const stream = await channel.stream(channel.model, {
    messages: [{ role: 'user', content: 'Call finish_probe exactly once with outcome ready.', timestamp: Date.now() }],
    tools: [conversationTool({
      name: 'finish_probe', description: 'Finish this synthetic transport probe.',
      inputSchema: z.object({ outcome: z.literal('ready') }),
    }, async () => ({ content: [], details: null }))],
  }, { maxTokens: 512, signal: AbortSignal.timeout(60_000) });
  const result = await stream.result();
  const calls = result.content.filter(part => part.type === 'toolCall');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name: 'finish_probe', arguments: { outcome: 'ready' } });
  expect(result.responseId).toBeTruthy();
  return { provider: profile.provider, model: profile.model, requestId: result.responseId };
}

it.skipIf(!enabled)('calls the configured editor connection with the parent decision protocol', async () => {
  console.info('CONTENT_MODEL_PROBE', await probe('content_production'));
}, 70_000);

it.skipIf(!enabled)('calls the configured writer connection with the author tool protocol', async () => {
  console.info('CONTENT_MODEL_PROBE', await probe('article_production'));
}, 70_000);
