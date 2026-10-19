import { DurableObject } from 'cloudflare:workers';
import { SiteProjection, isTopic, type RoomSql } from './projection';
import { countReads } from './read-count';

type Attachment = { userId: string; topics: string[] };
type ClientMessage = { type?: unknown; topics?: unknown };
const MAX_TOPICS = 12;

/**
 * One room per site (docs/real-time-updates-and-cache-architecture.md §7). Browsers connect through the Worker, which has
 * already checked the session and site ownership. Connections use the hibernation API: with no
 * change to push the room is evicted and not billed, while the platform keeps sockets open and
 * answers heartbeats. Nothing here may keep the object awake: no setTimeout/setInterval and no pending
 * fetches. Deferred work uses the storage alarm, which wakes the room without holding it in memory.
 */
export class SiteRoom extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();
  /** D1 rows read by the current room action (actions run one at a time). */
  private rowsRead = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private projection(siteId: string) {
    const sql: RoomSql = { exec: (query, ...params) => this.ctx.storage.sql.exec(query, ...params).toArray() as never[] };
    return new SiteProjection(sql, { DB: countReads(this.env.DB, rows => { this.rowsRead += rows; }) as never }, siteId, this.env.CF_VERSION_METADATA?.id ?? 'local');
  }
  private siteId(fallback = ''): string {
    const stored = this.ctx.storage.kv.get<string>('site_id');
    if (stored) return stored;
    if (fallback) this.ctx.storage.kv.put('site_id', fallback);
    return fallback;
  }
  /** Room work runs one at a time so change batches apply in order. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = () => { this.rowsRead = 0; return work(); };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async fetch(request: Request): Promise<Response> {
    const siteId = this.siteId(request.headers.get('X-Room-Site') || '');
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || !siteId) return new Response('WebSocket required', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId: request.headers.get('X-Room-User') || '', topics: [] } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Called after writes (and by the minute backstop). Carries no data: the room reads its change log.
   * Returns at once so a writer (an Agent step) never waits for live-view work.
   */
  async poke(siteId: string): Promise<void> {
    const id = this.siteId(siteId);
    this.ctx.waitUntil(this.serial(async () => {
      const projection = this.projection(id);
      const changed = await projection.catchUp();
      const rebuilt = await this.heal(projection, id);
      this.broadcast(id, [...new Set([...changed, ...rebuilt])]);
      await this.arm(projection);
      if (projection.processed || rebuilt.length) this.log('catch_up', id, { changes: projection.processed, built: projection.builtTopics(), pushed: changed, rebuilt });
    }).catch(error => console.error('Site room catch-up failed', id, String(error))));
  }

  /** Throttled member-panel topics that changed inside their window are rebuilt when it ends. */
  async alarm() {
    const id = this.siteId();
    if (!id) return;
    await this.serial(async () => {
      const projection = this.projection(id);
      const changed = await projection.flushDue();
      this.broadcast(id, changed);
      if (changed.length) this.log('refresh', id, { pushed: changed });
      await this.arm(projection);
    });
  }
  private async arm(projection: SiteProjection) {
    const due = projection.nextDue();
    if (due === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > due) await this.ctx.storage.setAlarm(due);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let message: ClientMessage;
    try { message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const topics = Array.isArray(message.topics) ? message.topics.filter((t): t is string => typeof t === 'string' && isTopic(t)) : [];
    const attachment = ws.deserializeAttachment() as Attachment;
    const siteId = this.siteId();
    if (message.type === 'subscribe') {
      const next = [...new Set([...attachment.topics, ...topics])].slice(-MAX_TOPICS);
      ws.serializeAttachment({ ...attachment, topics: next } satisfies Attachment);
      await this.serial(async () => {
        const projection = this.projection(siteId);
        for (const topic of topics) {
          // A missing topic is final; a failed build (D1 unavailable, quota exhausted) is retried by the page.
          let reply: object;
          try {
            const state = await projection.subscribe(topic);
            if (!state) this.forget(ws, topic);
            reply = state ? { type: 'state', topic, ...state } : { type: 'error', topic, reason: 'not_found' };
          } catch (error) {
            console.error('Site room subscribe failed', siteId, topic, String(error));
            reply = { type: 'error', topic, reason: 'unavailable' };
          }
          ws.send(JSON.stringify(reply));
        }
        this.release(projection);
        // The catch-up inside a build may have marked member panels; they need the alarm too.
        await this.arm(projection);
        this.log('subscribe', siteId, { topics, built: projection.builtTopics() });
      });
    } else if (message.type === 'unsubscribe') {
      ws.serializeAttachment({ ...attachment, topics: attachment.topics.filter(t => !topics.includes(t)) } satisfies Attachment);
      await this.serial(async () => this.release(this.projection(siteId)));
    }
  }

  async webSocketClose(ws: WebSocket) {
    ws.close();
    await this.serial(async () => this.release(this.projection(this.siteId())));
  }
  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws); }

  /**
   * Invariant: every topic a connection watches is maintained. A deploy (version reset) or a failed
   * build can leave a watched topic unbuilt while the page stays connected and never resubscribes;
   * rebuild those here and push them, instead of relying on every deploy dropping every socket.
   */
  private async heal(projection: SiteProjection, siteId: string): Promise<string[]> {
    const built = new Set(projection.builtTopics());
    const missing = [...this.watched()].filter(topic => !built.has(topic));
    const rebuilt: string[] = [];
    for (const topic of missing) {
      try {
        if (await projection.subscribe(topic)) rebuilt.push(topic);
        else for (const ws of this.ctx.getWebSockets()) this.forget(ws, topic);
      } catch (error) { console.error('Site room rebuild failed', siteId, topic, String(error)); }
    }
    return rebuilt;
  }
  private watched(): Set<string> {
    return new Set(this.ctx.getWebSockets().flatMap(ws => (ws.deserializeAttachment() as Attachment | null)?.topics ?? []));
  }
  /** A topic that does not exist for this site is removed from the connection, so it is not retried. */
  private forget(ws: WebSocket, topic: string) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.topics.includes(topic)) ws.serializeAttachment({ ...attachment, topics: attachment.topics.filter(t => t !== topic) } satisfies Attachment);
  }

  /** Topics nobody watches stop being maintained; the next subscriber rebuilds them from D1. */
  private release(projection: SiteProjection) {
    const watched = this.watched();
    const dropped = projection.builtTopics().filter(topic => !watched.has(topic));
    for (const topic of dropped) projection.drop(topic);
    if (dropped.length) this.log('release', this.siteId(), { dropped, watched: [...watched] });
  }

  /** One structured line per room action, so production shows what the room maintains and pushes. */
  private log(event: string, siteId: string, detail: Record<string, unknown>) {
    console.log(JSON.stringify({ room: event, site: siteId, sockets: this.ctx.getWebSockets().length, rows_read: this.rowsRead, ...detail }));
  }

  private broadcast(siteId: string, topics: string[]) {
    if (!topics.length) return;
    const projection = this.projection(siteId);
    const states = new Map(topics.map(topic => [topic, projection.state(topic)]));
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      for (const topic of attachment?.topics ?? []) {
        const state = states.get(topic);
        if (state) { try { ws.send(JSON.stringify({ type: 'state', topic, ...state })); } catch { /* closing socket */ } }
      }
    }
  }
}
