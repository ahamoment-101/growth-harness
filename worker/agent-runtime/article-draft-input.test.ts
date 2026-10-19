import { expect, it } from 'vitest';
import { z } from 'zod';
import { adaptArticleDraftModelResponse, saveArticleDraftInputSchema, submitEditorialArticleInputSchema } from './article-production-tools';
import { runAgentLoopContinue, type AgentContext, type AgentLoopConfig } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { conversationTool } from './conversation-tools';

const bundle = {
  versions: [{ locale: 'en', slug: 'writing-from-memory', title: 'Writing From Memory', excerpt: 'Practice writing', content: 'Useful article' }],
  seo_contract: { search_intent: 'Learn', reader_value: 'Practice', direct_answer: 'Write from memory', primary_keyword: 'writing from memory', supporting_terms: [], geo_summary: 'Practice writing' },
  ledger_ref: 'ref-ledger', coverage_response: [],
};

it('preserves the pinned model schema and accepts an explicit nested draft judgment', () => {
  expect(z.toJSONSchema(saveArticleDraftInputSchema, { io: 'input' }))
    .toEqual(z.toJSONSchema(submitEditorialArticleInputSchema, { io: 'input' }));
  expect(saveArticleDraftInputSchema.parse({ bundle: { ...bundle, judgment_summary: 'Revise the draft' } }))
    .toMatchObject({ bundle, judgment_summary: 'Revise the draft' });
  expect(saveArticleDraftInputSchema.parse({ bundle, judgment_summary: 'Top-level decision' }).judgment_summary)
    .toBe('Top-level decision');
  expect(saveArticleDraftInputSchema.safeParse({ bundle: { ...bundle, judgment_summary: 1 } }).success).toBe(false);
  expect(saveArticleDraftInputSchema.safeParse({ bundle }).success).toBe(false);
});

it('lifts the explicit nested judgment before Pi validates the saved provider response', async () => {
  const model: Model<'openai-completions'> = { id: 'test', name: 'test', api: 'openai-completions', provider: 'test',
    baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const raw: AssistantMessage = { role: 'assistant', content: [{ type: 'toolCall', id: 'save', name: 'save_article_draft',
    arguments: { bundle: { ...bundle, judgment_summary: 'Revise the draft' } } }], api: model.api, provider: model.provider,
    model: model.id, stopReason: 'toolUse', timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
      totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const adapted = adaptArticleDraftModelResponse(raw);
  expect(raw.content[0]).toMatchObject({ arguments: { bundle: { judgment_summary: 'Revise the draft' } } });
  const saved: unknown[] = [];
  const tool = conversationTool({ name: 'save_article_draft', description: 'Save', inputSchema: saveArticleDraftInputSchema },
    async (_id, input) => { saved.push(input); return { content: [{ type: 'text', text: 'saved' }], details: {} }; });
  const context: AgentContext = { systemPrompt: 'Test', messages: [{ role: 'user', content: 'Save', timestamp: 0 }], tools: [tool] };
  const config: AgentLoopConfig = { model, convertToLlm: messages => messages.filter(message =>
    message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult'), toolExecution: 'sequential' };
  let called = false;
  await runAgentLoopContinue(context, config, () => {}, undefined, () => {
    const message = called ? { ...raw, content: [], stopReason: 'stop' as const } : adapted;
    called = true;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    return stream;
  });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ judgment_summary: 'Revise the draft' });
});
