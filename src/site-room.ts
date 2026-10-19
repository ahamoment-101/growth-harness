import { useEffect, useState, useSyncExternalStore } from 'react';
import { checkSessionAfterDisconnect } from './auth-session';

/**
 * One live connection per site per tab to the site's room (docs/real-time-updates-and-cache-architecture.md §8–9).
 * Components subscribe to topics; the room pushes each topic's full current state on subscribe
 * and after every change. There is no polling: reconnects resubscribe and receive fresh state.
 */
type Listener = () => void;
type TopicState = { v: number; data: unknown } | { error: 'not_found' | 'unavailable' };
const HEARTBEAT_MS = 30_000;
const IDLE_CLOSE_MS = 60_000;

class RoomConnection {
  private ws: WebSocket | null = null;
  private readonly topics = new Map<string, Set<Listener>>();
  private readonly states = new Map<string, TopicState>();
  private readonly statusListeners = new Set<Listener>();
  private attempt = 0;
  private reconnectTimer = 0;
  private heartbeat = 0;
  private idleTimer = 0;
  /** Topics whose build failed on the server, with their retry timer and attempt count. */
  private readonly retries = new Map<string, { timer: number; attempt: number }>();
  connected = false;
  private readonly siteId: string;

  constructor(siteId: string) {
    this.siteId = siteId;
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private readonly onVisible = () => {
    // A tab coming back reconnects at once instead of waiting out its backoff.
    if (document.visibilityState === 'visible' && !this.ws && this.topics.size) { window.clearTimeout(this.reconnectTimer); this.connect(); }
  };

  state(topic: string) { return this.states.get(topic); }

  subscribe(topic: string, listener: Listener): () => void {
    window.clearTimeout(this.idleTimer);
    let listeners = this.topics.get(topic);
    const first = !listeners;
    if (!listeners) { listeners = new Set(); this.topics.set(topic, listeners); }
    listeners.add(listener);
    if (!this.ws) this.connect();
    else if (first) this.send({ type: 'subscribe', topics: [topic] });
    return () => {
      listeners!.delete(listener);
      if (listeners!.size) return;
      this.topics.delete(topic);
      this.states.delete(topic);
      this.clearRetry(topic);
      this.send({ type: 'unsubscribe', topics: [topic] });
      if (!this.topics.size) this.idleTimer = window.setTimeout(() => this.close(), IDLE_CLOSE_MS);
    };
  }

  private retry(topic: string) {
    const previous = this.retries.get(topic);
    window.clearTimeout(previous?.timer);
    const attempt = (previous?.attempt ?? 0) + 1;
    const timer = window.setTimeout(() => { if (this.topics.has(topic)) this.send({ type: 'subscribe', topics: [topic] }); }, Math.min(120_000, 5000 * 2 ** (attempt - 1)));
    this.retries.set(topic, { timer, attempt });
  }
  private clearRetry(topic: string) {
    window.clearTimeout(this.retries.get(topic)?.timer);
    this.retries.delete(topic);
  }

  onStatus(listener: Listener) { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }

  private send(message: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    for (const listener of this.statusListeners) listener();
  }

  private connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/sites/${encodeURIComponent(this.siteId)}/room`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setConnected(true);
      if (this.topics.size) this.send({ type: 'subscribe', topics: [...this.topics.keys()] });
      this.heartbeat = window.setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, HEARTBEAT_MS);
    };
    ws.onmessage = event => {
      if (typeof event.data !== 'string' || event.data === 'pong') return;
      let message: { type?: string; topic?: string; v?: number; data?: unknown; reason?: string };
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message.topic || !this.topics.has(message.topic)) return;
      if (message.type === 'state') {
        this.states.set(message.topic, { v: message.v ?? 0, data: message.data });
        this.clearRetry(message.topic);
      } else if (message.type === 'error') {
        const reason = message.reason === 'not_found' ? 'not_found' : 'unavailable';
        // Keep the last good state while a temporary failure is retried.
        if (reason === 'not_found' || !this.states.has(message.topic)) this.states.set(message.topic, { error: reason });
        if (reason === 'unavailable') this.retry(message.topic);
      } else return;
      for (const listener of this.topics.get(message.topic) ?? []) listener();
    };
    ws.onclose = async () => {
      window.clearInterval(this.heartbeat);
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnected(false);
      if (!this.topics.size) return;
      if (await checkSessionAfterDisconnect()) return;
      // Another subscriber or a visible tab may have already reconnected during the check.
      if (this.ws || !this.topics.size) return;
      // First retry is spread over 1–10 s so a deploy does not reconnect every tab at once; then back off.
      // After repeated failures (expired session, outage) slow to 5 minutes so stale tabs cannot flood the Worker.
      const cap = this.attempt >= 5 ? 300_000 : 30_000;
      const delay = this.attempt === 0 ? 1000 + Math.random() * 9000 : Math.min(cap, 1000 * 2 ** this.attempt) + Math.random() * 1000;
      this.attempt++;
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private close() {
    window.clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setConnected(false);
  }
}

const connections = new Map<string, RoomConnection>();
function connection(siteId: string) {
  let room = connections.get(siteId);
  if (!room) { room = new RoomConnection(siteId); connections.set(siteId, room); }
  return room;
}

/** Live state of one topic of a site's room. `data` stays undefined until the first push. */
export function useRoomTopic<T>(siteId: string, topic: string | null): { data: T | undefined; error: string; connected: boolean } {
  const room = connection(siteId);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!topic) return;
    return room.subscribe(topic, () => setTick(tick => tick + 1));
  }, [room, topic]);
  const connected = useSyncExternalStore(listener => room.onStatus(listener), () => room.connected);
  const state = topic ? room.state(topic) : undefined;
  if (!state) return { data: undefined, error: '', connected };
  if ('error' in state) return { data: undefined, error: state.error, connected };
  return { data: state.data as T, error: '', connected };
}
