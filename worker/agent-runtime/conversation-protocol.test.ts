import { describe, expect, it } from 'vitest';
import { runAgentLoopContinue, type AgentContext, type AgentEventSink, type AgentLoopConfig, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Message, type Model } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { conversationTool } from './conversation-tools';
import { agentDefinition } from './definitions';
import { strategyTaskTools } from './strategy-task';
import type { RuntimeAgentEnv } from './env';

const model: Model<'openai-completions'> = {
  id: 'protocol-test', name: 'Protocol test', api: 'openai-completions', provider: 'openai',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4000,
};
function response(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
const call = (id: string, value: unknown) => ({ type: 'toolCall' as const, id, name: 'save_note', arguments: { value } });
function scripted(messages: AssistantMessage[], requests: Context[] = []): StreamFn {
  return (_model, context) => {
    requests.push(structuredClone({ ...context, tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) }));
    const message = messages.shift();
    if (!message) throw new Error('Unexpected model request in protocol test');
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      stream.push({ type: 'error', reason: message.stopReason, error: message });
    } else if (message.stopReason !== 'pending') stream.push({ type: 'done', reason: message.stopReason, message });
    else throw new Error('A pending response cannot end this test stream');
    return stream;
  };
}
function fixture() {
  const effects: string[] = [];
  const tool = conversationTool({ name: 'save_note', description: 'Save a note', inputSchema: z.object({ value: z.string() }) }, async (id, input) => {
    const value = (input as { value: string }).value;
    effects.push(`${id}:${value}`);
    return { content: [{ type: 'text', text: value }], details: { id } };
  });
  const context: AgentContext = { systemPrompt: 'Internal task', messages: [{ role: 'user', content: 'Research', timestamp: 0 }], tools: [tool] };
  const config: AgentLoopConfig = { model, convertToLlm: messages => messages.filter((message): message is Message =>
    message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult'), toolExecution: 'sequential' };
  return { effects, context, config };
}

describe('Pi conversation protocol', () => {
  it('keeps assistant text and ordered tool identities in the next native request', async () => {
    const { effects, context, config } = fixture();
    const requests: Context[] = [];
    await runAgentLoopContinue(context, config, () => {}, undefined, scripted([
      response([{ type: 'text', text: 'I will record two observations.' }, call('a', 'first'), call('b', 'second')], 'toolUse'),
      response([{ type: 'text', text: 'Done' }]),
    ], requests));
    expect(effects).toEqual(['a:first', 'b:second']);
    expect(requests[1].messages.map(m => m.role)).toEqual(['user', 'assistant', 'toolResult', 'toolResult']);
    expect(requests[1].messages[1].content[0]).toEqual({ type: 'text', text: 'I will record two observations.' });
    expect(requests[1].messages.slice(2).map(m => m.role === 'toolResult' && m.toolCallId)).toEqual(['a', 'b']);
  });

  it('returns structural failures to the conversation and allows correction without effects', async () => {
    const { effects, context, config } = fixture();
    const requests: Context[] = [];
    await runAgentLoopContinue(context, config, () => {}, undefined, scripted([
      response([call('bad', { wrong: true })], 'toolUse'),
      response([call('fixed', 'corrected')], 'toolUse'), response([]),
    ], requests));
    expect(effects).toEqual(['fixed:corrected']);
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'bad', isError: true });
  });

  it('does not execute calls from a truncated assistant response', async () => {
    const { effects, context, config } = fixture();
    const requests: Context[] = [];
    await runAgentLoopContinue(context, config, () => {}, undefined, scripted([
      response([call('cut', 'apparently complete')], 'length'), response([]),
    ], requests));
    expect(effects).toEqual([]);
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'cut', isError: true });
    expect(requests[1].messages[1]).toMatchObject({ stopReason: 'length' });
  });

  it('rejects SDK primitive coercion before it can change business input meanings', async () => {
    const { effects, context, config } = fixture();
    const messages = await runAgentLoopContinue(context, config, () => {}, undefined, scripted([
      response([call('null', null), call('number', 42), call('boolean', false), call('empty', '')], 'toolUse'), response([]),
    ]));
    expect(effects).toEqual(['empty:']);
    expect(messages.filter(m => m.role === 'toolResult').map(m => m.role === 'toolResult' && [m.toolCallId, m.isError])).toEqual([
      ['null', true], ['number', true], ['boolean', true], ['empty', false],
    ]);
  });

  it('awaits assistant persistence before effects and tool-result persistence before the next effect', async () => {
    for (const failure of ['assistant', 'toolResult']) {
      const { effects, context, config } = fixture();
      const sink: AgentEventSink = async event => {
        if (event.type === 'message_end' && event.message.role === failure) {
          await Promise.resolve();
          throw new Error('Storage unavailable');
        }
      };
      await expect(runAgentLoopContinue(context, config, sink, undefined, scripted([
        response([call('a', 'first'), call('b', 'second')], 'toolUse'),
      ]))).rejects.toThrow('Storage unavailable');
      expect(effects).toEqual(failure === 'assistant' ? [] : ['a:first']);
    }
  });

  it('can block remaining calls after a terminal effect while preserving correlated results', async () => {
    const { effects, context, config } = fixture();
    let terminal = false;
    config.beforeToolCall = async () => terminal ? { block: true, reason: 'Task already completed', terminate: true } : undefined;
    config.afterToolCall = async ({ isError }) => { if (!isError) terminal = true; return undefined; };
    config.shouldStopAfterTurn = () => terminal;
    const messages = await runAgentLoopContinue(context, config, () => {}, undefined, scripted([
      response([call('submit', 'committed'), call('late', 'must not write')], 'toolUse'),
    ]));
    expect(effects).toEqual(['submit:committed']);
    expect(messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'late', isError: true });
  });

  it('projects every current research tool from its authoritative schema', () => {
    const env = {} as RuntimeAgentEnv;
    const strategy = agentDefinition('strategy_research');
    const research = agentDefinition('deep_research');
    const catalogs = [
      { definition: strategy, registry: strategyTaskTools({ env, definition: strategy }) },
    ];
    let count = 0;
    for (const { definition, registry } of catalogs) {
      for (const name of registry.names()) {
        const contract = registry.resolve(definition, name);
        const adapted = conversationTool(contract, async () => { throw new Error('Inspection only'); });
        expect(adapted.parameters).toMatchObject({ type: 'object' });
        expect(JSON.parse(JSON.stringify(adapted.parameters))).toEqual(z.toJSONSchema(contract.inputSchema, { io: 'input' }));
        count++;
      }
    }
    expect(count).toBe(strategy.tools.length + research.tools.length);
  });
});
