import type { D1Database } from '@cloudflare/workers-types';
import type { FetchFunction } from '@earendil-works/pi-ai';
import { persistRuntimeRequest } from './runtime-content';
import { observedFetch } from './request-accounting';
const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');

/** Observe the actual serialized payload and provider-reported cache fields. */
export function requestObservation(db: D1Database, taskId: string, requestId: string, fetch: FetchFunction = observedFetch) {
  let httpStatus = 0;
  let errorCode: string | undefined;
  let cache: Record<string, unknown> = { verification: 'unavailable' };
  return {
    get httpStatus() { return httpStatus; },
    get errorCode() { return errorCode; },
    onPayload: async (value: unknown) => {
      const wire = value as Record<string, unknown>;
      const version = await db.prepare('select coalesce(max(version),0) as version from agent_conversation_compactions where task_id=?').bind(taskId).first<number>('version');
      const prefix = { model: wire.model, tools: wire.tools,
        messages: Array.isArray(wire.messages) ? wire.messages.slice(0, 2) : [],
        system: wire.system, instructions: wire.instructions,
        input: Array.isArray(wire.input) ? wire.input.slice(0, 2) : wire.input,
      };
      await db.prepare(`insert or ignore into agent_model_request_observations(request_id,task_id,wire_json,prefix_hash,tool_hash,compaction_version) values(?,?,?,?,?,?)`)
        .bind(requestId, taskId, await persistRuntimeRequest(db, wire), await hash(prefix), await hash(wire.tools || []), version || 0).run();
    },
    fetch: (async (url, init) => {
      const response = await fetch(url, init);
      httpStatus = response.status;
      if (response.status >= 400 && response.headers.get('content-type')?.includes('application/json')) {
        try {
          const body = await response.clone().json() as { error?: { code?: unknown } };
          if (typeof body.error?.code === 'string') errorCode = body.error.code;
        } catch { /* An undecodable error body does not establish its category. */ }
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
      let buffer = ''; const decoder = new TextDecoder();
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            try {
              const event = JSON.parse(line.slice(5).trimStart());
              const usage = event.usage || event.message?.usage || event.response?.usage;
              if (!usage) continue;
              const read = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens;
              const write = usage.cache_creation_input_tokens ?? usage.prompt_tokens_details?.cache_write_tokens;
              const measured = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
              if (measured(read) || measured(write)) cache = { verification: 'reported',
                cache_read_tokens: measured(read) ? read : cache.cache_read_tokens ?? null,
                cache_write_tokens: measured(write) ? write : cache.cache_write_tokens ?? null,
              };
            } catch { /* Other SSE events are not cache measurements. */ }
          }
          controller.enqueue(chunk);
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }) as FetchFunction,
    commit: () => db.prepare('update agent_model_request_observations set cache_json=? where request_id=?').bind(JSON.stringify(cache), requestId).run(),
  };
}
