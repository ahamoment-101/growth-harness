import type { Message } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { conversationHistoryTool } from './conversation-context';
import { taskTestDb } from './task-test-db';
import { attachTask } from './task-store';
import { agentDefinition } from './definitions';
import { appendConversationMessage, initializeConversation, readConversation } from './conversation-store';
import type { RuntimeAgentEnv } from './env';

it('reads exact archived message pages only for the current task', async () => {
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  await initializeConversation(f.db, task, 'Research', {});
  const message: Message = { role: 'user', content: 'Known original material'.repeat(800), timestamp: 1 };
  await appendConversationMessage(f.db, task, 'trigger', message);
  const tool = conversationHistoryTool({ DB: f.db } as RuntimeAgentEnv);
  const context = { runId: task.active_run_id, workspaceId: 'w', siteId: 's', idempotencyKey: 'read' };
  const call = async (args: unknown) => await tool.execute!(tool.inputSchema.parse(args), context) as { excerpt: string; next_offset: number | null; messages: unknown[] };
  expect((await call({})).messages).toHaveLength(1);
  let full = ''; let offset = 0;
  for (;;) {
    const result = await call({ sequence: 1, offset });
    full += result.excerpt;
    if (result.next_offset === null) break;
    offset = result.next_offset;
  }
  expect(JSON.parse(full)).toEqual(message);
  expect((await readConversation(f.db, task))!.messages[0].message).toEqual(message);
  await expect(tool.execute!(tool.inputSchema.parse({ sequence: 1 }), { ...context, workspaceId: 'another' })).rejects.toThrow('scope');
});

it('excludes private reasoning and host accounting from assistant archive pages while preserving exact tool arguments', async () => {
  const f = taskTestDb();
  const task = await attachTask(f.db, f.run(), agentDefinition('strategy_research'));
  await initializeConversation(f.db, task, 'Research', {});
  await appendConversationMessage(f.db, task, 'response', { role: 'assistant', timestamp: 1, stopReason: 'toolUse',
    content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING_SENTINEL' }, { type: 'text', text: 'Observed candidate version 7' },
      { type: 'toolCall', id: 'call-1', name: 'review_candidate', arguments: { reference: 'candidate-exact', version: 7 } }],
    runtimeCapacity: { prefixHash: 'HOST_ACCOUNTING_SENTINEL' },
  } as unknown as Message);
  const tool = conversationHistoryTool({ DB: f.db } as RuntimeAgentEnv);
  const result = await tool.execute!(tool.inputSchema.parse({ sequence: 1, max_characters: 4096 }),
    { runId: task.active_run_id, workspaceId: 'w', siteId: 's', idempotencyKey: 'inspect' }) as { excerpt: string };
  expect(result.excerpt).not.toContain('PRIVATE_REASONING_SENTINEL');
  expect(result.excerpt).not.toContain('HOST_ACCOUNTING_SENTINEL');
  expect(JSON.parse(result.excerpt).content).toEqual([
    { type: 'text', text: 'Observed candidate version 7' },
    { type: 'toolCall', id: 'call-1', name: 'review_candidate', arguments: { reference: 'candidate-exact', version: 7 } },
  ]);
});
