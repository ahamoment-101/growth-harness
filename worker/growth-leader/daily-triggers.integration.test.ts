import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from '../agent-runtime/env';
import { schemaTestDb } from '../lib/schema-test-db';
import { activateRuntimeExecution, authorityForExecution, currentExecution } from '../agent-runtime/runtime-executions';
import { executionEnvironment } from '../agent-runtime/execution-context';
import { replayConversationResponse } from '../agent-runtime/conversation-replay';
import { runLeaderConversation } from './runtime';
import { dispatchDailyTriggers, saveDailyTrigger } from './daily-triggers';

const model: Model<'openai-completions'> = {
  id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://fixture.invalid',
  reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const step = { do: async (_key: string, options: unknown, fn?: () => Promise<unknown>) =>
  (fn || options as () => Promise<unknown>)(), sleep: async () => {} } as unknown as RuntimeWorkflowStep;
const stopAfterDelegation = new Error('Fixture stops after delegation');

function reply(call?: { id: string; name: string; arguments: Record<string, unknown> }): AssistantMessage {
  return { role: 'assistant', content: call ? [{ type: 'toolCall', ...call }] : [{ type: 'text', text: 'Topic selection has been arranged.' }],
    api: model.api, provider: model.provider, model: model.id, stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(),
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

describe('daily trigger isolated startup', () => {
  it('repairs a missing scope argument in the same scheduled Leader conversation before delegation', async () => {
    const f = schemaTestDb();
    f.insert('workspaces', { id: 'w', name: 'Sandbox' });
    f.insert('sites', { id: 's', workspace_id: 'w', name: 'Sandbox site', ingest_url: 'https://example.invalid', source_locale: 'zh-CN' });
    const workflows: string[] = [];
    const env = { DB: f.db, AGENT_RUNTIME_ENABLED: 'true', AGENT_WORKFLOW: {
      create: async ({ id }: { id: string }) => { workflows.push(id); return { id }; },
    } } as unknown as RuntimeAgentEnv;
    await saveDailyTrigger(f.db, 'w', 's', { enabled: true, task_mode: 'scheduled', action: 'start_topic_batch', local_time: '09:00' },
      new Date('2026-09-26T00:59:00Z'));
    await dispatchDailyTriggers(env, new Date('2026-09-26T01:00:00Z'));
    const conversationId = 'daily-topics:s:2026-09-26';
    expect(f.sqlite.prepare('select id,title from leader_conversations').all()).toEqual([
      { id: conversationId, title: '2026-09-26 daily topic selection' },
    ]);
    expect(f.sqlite.prepare('select trigger,schedule_key from agent_runs where id=?').get(conversationId)).toEqual({
      trigger: 'cron', schedule_key: 'daily-trigger:s:2026-09-26',
    });
    expect(workflows).toHaveLength(1);

    const execution = await currentExecution(f.db, conversationId);
    expect(execution).not.toBeNull();
    await activateRuntimeExecution(f.db, authorityForExecution(execution!), execution!.workflow_id);
    const requests: Array<{ messages: unknown[]; tools: Array<{ name: string }> }> = [];
    let sentDelegation = false;
    let repairedDelegation = false;
    let scopeRef = '';
    const stream: StreamFn = (m, context, options) => {
      requests.push({ messages: context.messages, tools: context.tools as Array<{ name: string }> });
      const latestTool = [...context.messages].reverse().find(message => message.role === 'toolResult');
      if (!sentDelegation && latestTool?.role === 'toolResult' && latestTool.toolName === 'discover_agents') {
        const body = latestTool.content.find(part => part.type === 'text')?.text;
        if (!body) throw new Error('Agent discovery returned no text result');
        const result = JSON.parse(body);
        const scope = result.scopes.find((item: { locale: string }) => item.locale === 'zh-CN');
        if (!scope) throw new Error('Chinese site language was not exposed to Leader');
        scopeRef = scope.scope_ref;
        sentDelegation = true;
        return replayConversationResponse(reply({ id: 'delegate-missing-scope', name: 'delegate_task', arguments: {
          agent_ref: 'topic_decision',
          goal: 'Start a new batch of Chinese topic selection for this site', reason: 'The user-saved daily topic selection trigger configuration is due',
          context: `Combining the existing keyword library and in-flight work, produce a batch of topics ready for review. scope_ref: ${scopeRef}`,
        } }), stream)(m, context, options);
      }
      if (latestTool?.role === 'toolResult' && latestTool.toolName === 'delegate_task') {
        if (repairedDelegation) throw stopAfterDelegation;
        const failure = latestTool.content.find(part => part.type === 'text')?.text || '';
        expect(failure).toContain('scope_ref');
        expect(failure).toContain('context');
        expect(f.sqlite.prepare("select count(*) n from agent_tasks where agent_id='topic_decision'").get()).toEqual({ n: 0 });
        repairedDelegation = true;
        return replayConversationResponse(reply({ id: 'delegate-with-scope', name: 'delegate_task', arguments: {
          agent_ref: 'topic_decision', scope_ref: scopeRef,
          goal: 'Start a new batch of Chinese topic selection for this site', reason: 'The user-saved daily topic selection trigger configuration is due',
          context: 'Combining the existing keyword library and in-flight work, produce a batch of topics ready for review.',
        } }), stream)(m, context, options);
      }
      if (requests.length > 8) throw new Error(`Fixture did not reach delegation: ${JSON.stringify(requests.map(request => request.messages.at(-1)))}`);
      return replayConversationResponse(reply({ id: `discover-daily-topics-${requests.length}`, name: 'discover_agents', arguments: {} }), stream)(m, context, options);
    };
    try {
      await runLeaderConversation({ env: executionEnvironment(env, authorityForExecution(execution!)), step,
        runId: conversationId, transport: { model, stream } });
    } catch (error) {
      if (error !== stopAfterDelegation) throw new Error(`${String(error)}; last messages: ${JSON.stringify(requests.map(request => request.messages.at(-1)))}`);
    }
    expect(JSON.stringify(requests[0].messages)).toContain('start a batch of topic selection');
    expect(repairedDelegation).toBe(true);
    expect(requests[0].tools.some(tool => tool.name === 'delegate_task')).toBe(true);
    const child = f.sqlite.prepare("select agent_id,parent_task_id,status from agent_tasks where agent_id='topic_decision'").get() as
      { agent_id: string; parent_task_id: string; status: string } | undefined;
    expect(child).toMatchObject({ agent_id: 'topic_decision', parent_task_id: conversationId });
    expect(f.sqlite.prepare('select count(*) n from agent_task_assignments where task_id=(select id from agent_tasks where agent_id=?)')
      .get('topic_decision')).toEqual({ n: 1 });
  });
});
