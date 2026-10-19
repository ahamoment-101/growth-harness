// @ts-nocheck Node-only opt-in transport probe; synthetic public content, no production writes.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { runAgentLoopContinue } from '@earendil-works/pi-agent-core';
import { conversationChannel } from './conversation-channel';
import { conversationTool } from './conversation-tools';
import { resolveModelProfile } from './model-registry';
import { editArticleInternalLinksInput, applyContentLinkEdits } from './content-link-editing';
import { PARENT_INTERNAL_LINK_INSTRUCTIONS } from './content-link-policy';

const enabled = process.env.CONTENT_LINKS_LIVE_VERIFY === '1';
for (const useful of [true, false]) it.skipIf(!enabled)(`serializes parent link editing and accepts ${useful ? 'a useful target' : 'zero links'} on the configured model`, async () => {
  const vars = {};
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) vars[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  const requests = [];
  const responses = [];
  const channel = conversationChannel({ ...resolveModelProfile(vars, 'content_production'), maxOutputTokens: 4096 }, async (url, init) => {
    if (requests.length >= 5) throw new Error('Synthetic probe request budget exhausted');
    requests.push(JSON.parse(String(init?.body)));
    try {
      const response = await fetch(url, init);
      responses.push({ status: response.status, content_type: response.headers.get('content-type') });
      return response;
    } catch (error) {
      responses.push({ error: error.name, cause: error.cause?.code || '' });
      throw error;
    }
  });
  const content = '## Email reply\n\nBefore sending your reply, check that its next step is clear. A checklist can help you review the message.';
  const candidate = { id: 'draft', group_id: 'synthetic-group', job_id: 'synthetic-job', child_run_id: 'author', attempt: 1,
    versions: [{ locale: 'en', title: 'Email reply', excerpt: 'Reply clearly', slug: 'email-reply', content }], seo_contract: {},
    policy: { blog_origin: 'https://blog.example.com', product_origin: '', hub_path: '/', hub_urls: {} } };
  const target = { job_id: 'checklist', locale: 'en', href: 'article:checklist', status: 'published',
    title: useful ? 'Email checklist' : 'Tomato planting calendar',
    content: useful ? 'Review who must act next, whether the requested action is explicit, and whether the date is unambiguous.' : 'Plant tomato seedlings after the last frost. Water the soil and support the stems.' };
  let edits = 0; let completed = false;
  const proof = crypto.randomUUID();
  const tools = [conversationTool({ name: 'edit_article_internal_links', description: 'Apply a local internal-link edit to observed candidate_ref=synthetic-candidate using target_refs=[synthetic-target].', inputSchema: editArticleInternalLinksInput }, async (_id, raw) => {
    const args = editArticleInternalLinksInput.parse(raw);
    expect(args.candidate_ref).toBe('synthetic-candidate');
    expect(useful).toBe(true);
    for (const edit of args.edits) expect(edit.target_refs).toEqual(['synthetic-target']);
    const result = applyContentLinkEdits(candidate, args, [target]);
    expect(result.counts[0].internal_links).toBeGreaterThan(0); expect(result.counts[0].internal_links).toBeLessThanOrEqual(3);
    edits++;
    return { content: [{ type: 'text', text: JSON.stringify({ candidate_ref: 'synthetic-edited', counts: result.counts, proof }) }], details: { proof } };
  }), conversationTool({ name: 'finish_synthetic_editorial_check', description: 'Finish this isolated probe with the link decision and explanation; this never publishes.',
    inputSchema: z.object({ decision: z.enum(['edited', 'unchanged']), reason: z.string().min(1) }) }, async (_id, raw) => {
    expect(raw.decision).toBe(useful ? 'edited' : 'unchanged'); completed = true;
    return { content: [{ type: 'text', text: JSON.stringify({ proof }) }], details: { proof } };
  })];
  const context = { systemPrompt: PARENT_INTERNAL_LINK_INSTRUCTIONS + '\nThis is an isolated protocol probe. The complete draft and target snapshot have already been read below. Decide whether the target adds useful detail. Use the edit tool if useful, then finish_synthetic_editorial_check. If unrelated, leave the draft unchanged and finish. No other pages exist in this fixture.',
    messages: [{ role: 'user', content: JSON.stringify({ candidate_ref: 'synthetic-candidate', candidate, target_ref: 'synthetic-target', target }), timestamp: Date.now() }], tools };
  await runAgentLoopContinue(context, { model: channel.model, maxTokens: 4096, convertToLlm: messages => messages,
    beforeToolCall: async () => completed ? { block: true, terminate: true, reason: 'Probe completed' } : undefined }, async event => {
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.errorMessage) {
      console.info('CONTENT_LINKS_TRANSPORT_FAILURE', JSON.stringify({ useful, requests: requests.length, responses, edits, completed }));
      throw new Error(event.message.errorMessage);
    }
  }, AbortSignal.timeout(90000), channel.stream);
  expect(completed).toBe(true); expect(edits).toBe(useful ? 1 : 0);
  const serialized = requests[0].tools.find(t => t.function.name === 'edit_article_internal_links').function.parameters;
  expect(serialized.type).toBe('object'); expect(serialized.properties.edits.type).toBe('array');
  expect(requests.some(r => r.messages.some(m => m.role === 'tool' && String(m.content).includes(proof)))).toBe(true);
  console.info('CONTENT_LINKS_LIVE', JSON.stringify({ model: channel.model.id, useful, edits, requests: requests.length, serialized_schema: true, receipt_readback: true }));
}, 100000);
