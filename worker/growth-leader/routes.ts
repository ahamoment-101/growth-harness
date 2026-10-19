import { z } from 'zod';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { createConversation, enqueueInput, listConversations, readLeaderDetail, wakeConversation, type LeaderScope } from './service';
import { dispatchPendingAgentEvents } from '../agent-events/pool';
const create = z.object({ id: z.string().uuid(), title: z.string().trim().min(1).max(200), context: z.string().max(20000).optional() });
const message = z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(20000) });
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
export async function handleLeaderRequest(request: Request, env: RuntimeAgentEnv, scope: LeaderScope, actorId: string, path: string, ctx: {waitUntil(promise:Promise<unknown>):void}) {
  const match = path.match(/^conversations(?:\/([^/]+)(\/messages)?)?$/);
  if (!match) return json({error:'not found'},404);
  try {
    // Live pages read these through the site room; HTTP serves one-off reads (earlier history, tools).
    if (!match[1] && request.method === 'GET') return json({ conversations: await listConversations(env,scope) });
    if (!match[1] && request.method === 'POST') return json(await createConversation(env,scope,create.parse(await request.json())),201);
    const id = decodeURIComponent(match[1] || '');
    if (!match[2] && request.method === 'GET') {
      const detail = await readLeaderDetail(env,scope,id);
      return detail ? json(detail) : json({error:'conversation not found'},404);
    }
    if (match[2] && request.method === 'POST') {
      const input = message.parse(await request.json());
      await enqueueInput(env,scope,id,{id:input.id,kind:'user',actorId,content:input.text});
      // Acceptance is durable. Dispatch failures remain recoverable without resending the user's text.
      ctx.waitUntil(wakeConversation(env,scope,id).then(() => dispatchPendingAgentEvents(env))
        .catch(error=>console.error('Leader dispatch pending',String(error))));
      return json({accepted:true,id:input.id},202);
    }
    return json({error:'method not supported'},405);
  } catch (error) { return json({error:error instanceof Error ? error.message : String(error)}, error instanceof z.ZodError ? 400 : 409); }
}
