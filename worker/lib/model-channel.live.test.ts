// Opt-in paid check. Uses only the selected profile and synthetic input.
import { localConfiguration } from '../../scripts/configuration';
import { expect, it } from 'vitest';
import { conversationChannel } from '../agent-runtime/conversation-channel';
import { resolveModelProfile } from '../agent-runtime/model-registry';
// @ts-ignore Test-only Node environment.
const enabled = process.env.MODEL_TRANSPORT_LIVE_VERIFY === '1';

it.skipIf(!enabled)('calls a tool through the configured connection without overriding its model or protocol', async () => {
  const { env } = localConfiguration();
  const profile = resolveModelProfile(env);
  const channel = conversationChannel(profile);
  const result = await (await channel.stream(channel.model, {
    messages: [{ role: 'user', content: 'Call finish_probe once with outcome ready.', timestamp: 0 }],
    tools: [{ name: 'finish_probe', description: 'Finish the synthetic protocol check.',
      parameters: { type: 'object', properties: { outcome: { type: 'string', enum: ['ready'] } }, required: ['outcome'] } }],
  }, { maxTokens: 1024, signal: AbortSignal.timeout(60_000) })).result();
  expect(result.stopReason).toBe('toolUse');
  expect(result.content).toContainEqual(expect.objectContaining({ type: 'toolCall', name: 'finish_probe', arguments: { outcome: 'ready' } }));
  console.info('MODEL_TRANSPORT_PROBE', { connection: profile.connection, protocol: profile.protocol, model: profile.model, usage: result.usage.totalTokens });
}, 70_000);
