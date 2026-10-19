import type { LeaderConversation, LeaderMessage, LeaderTask } from '../../shared/growth-leader';
import type { WorkNode } from '../../shared/agent-work';

export type Tone = 'active' | 'waiting' | 'done' | 'alert' | 'idle';
export type Phase = { label: string; tone: Tone };
export type LeaderFeedItem = { kind: 'message'; value: LeaderMessage } | { kind: 'hitl'; value: WorkNode };

/** Keep HITL in the conversation where it appeared while preserving transcript order. */
export function mergeLeaderFeed(messages: LeaderMessage[], hitl: WorkNode[]): LeaderFeedItem[] {
  const requests = [...hitl].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const result: LeaderFeedItem[] = [];
  let index = 0;
  for (const message of messages) {
    while (index < requests.length && requests[index].at < message.created_at) result.push({ kind: 'hitl', value: requests[index++] });
    result.push({ kind: 'message', value: message });
  }
  while (index < requests.length) result.push({ kind: 'hitl', value: requests[index++] });
  return result;
}

const closedStates = ['completed', 'cancelled', 'failed'];
export const isClosed = (c: Pick<LeaderConversation, 'status'>) => closedStates.includes(c.status);

/** What the person needs to know about a conversation, not the Run's internal state. */
export function conversationPhase(c: Pick<LeaderConversation, 'status' | 'team_active' | 'pending_inputs'>): Phase {
  if (c.status === 'failed') return { label: 'Interrupted by error', tone: 'alert' };
  if (closedStates.includes(c.status)) return { label: 'Ended', tone: 'done' };
  if (c.status === 'paused') return { label: 'Paused', tone: 'alert' };
  if (c.status === 'running' || c.pending_inputs > 0) return { label: 'Leader is thinking', tone: 'active' };
  if (c.team_active > 0) return { label: 'Team working', tone: 'active' };
  if (c.status === 'ready') return { label: 'Not started yet', tone: 'idle' };
  return { label: 'Waiting for your reply', tone: 'waiting' };
}

export function taskPhase(t: Pick<LeaderTask, 'status' | 'outcome' | 'attention_count'>): Phase {
  if (t.attention_count > 0) return { label: 'Awaiting your confirmation', tone: 'waiting' };
  switch (t.status) {
    case 'running': return { label: 'In progress', tone: 'active' };
    case 'waiting': return { label: 'Waiting for next step', tone: 'idle' };
    case 'paused': return { label: 'Interrupted', tone: 'alert' };
    case 'failed': return { label: 'Failed', tone: 'alert' };
    case 'cancelled': return { label: 'Cancelled', tone: 'done' };
    case 'completed': return t.outcome === 'unable_to_complete' ? { label: 'Could not be completed', tone: 'alert' } : { label: 'Delivered', tone: 'done' };
    default: return { label: 'In progress', tone: 'idle' };
  }
}

/** One team member in the rail, with each delegated task still independently accessible. */
export function groupLeaderTasks(tasks: readonly LeaderTask[]): Array<{ agent_id: string; tasks: LeaderTask[] }> {
  const groups = new Map<string, LeaderTask[]>();
  for (const task of [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))) {
    const group = groups.get(task.agent_id) ?? [];
    group.push(task);
    groups.set(task.agent_id, group);
  }
  return [...groups].map(([agent_id, memberTasks]) => ({ agent_id, tasks: memberTasks }));
}

/** Report headline verb for a delivered child checkpoint. */
export function reportVerb(t: Pick<LeaderTask, 'status' | 'outcome'> | undefined): string {
  if (!t) return 'sent a report';
  if (t.status === 'completed') return t.outcome === 'unable_to_complete' ? 'the report could not be completed' : 'delivered the results';
  if (t.status === 'failed') return 'Report Task failed';
  if (t.status === 'cancelled') return 'Task has been canceled';
  return 'sent a progress update';
}

const DEFAULT_TITLE = 'New Conversation';
function clip(text: string, max: number) { return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text; }

/** Title from the person's first message: its first sentence, kept short. */
export function titleFromMessage(text: string): string {
  const line = text.split('\n').map(s => s.trim()).find(Boolean) || '';
  const sentence = line.split(/(?<=[.!?])\s+|(?<=[\u3002\uff01\uff1f])/)[0].replace(/[.\u3002\uff01\uff1f!?]+$/, '').trim();
  return sentence ? clip(sentence, 24) : DEFAULT_TITLE;
}

export function conversationTitle(c: Pick<LeaderConversation, 'title' | 'preview'>): string {
  const title = c.title.trim();
  if (title && title !== DEFAULT_TITLE) return title;
  return c.preview ? titleFromMessage(c.preview) : DEFAULT_TITLE;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor((now - at) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(now) - day(at)) / 86400000);
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days === 0) return `Today ${hm}`;
  if (days === 1) return `Yesterday ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const errors: Array<[RegExp, string]> = [
  [/closed/i, 'This conversation has ended and no more messages can be sent.'],
  [/not found/i, 'This conversation could not be found. Please refresh and try again.'],
  [/conflicts/i, 'This message does not match the previous request. Please send it again.'],
];
export function friendlyError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return errors.find(([pattern]) => pattern.test(message))?.[1] || fallback;
}

/** Active conversations first by latest activity; ended ones are kept apart. */
export function groupConversations<T extends LeaderConversation>(list: readonly T[]) {
  const sorted = [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
  return { open: sorted.filter(c => !isClosed(c)), ended: sorted.filter(isClosed) };
}

/**
 * Loaded full history followed by the live tail. Messages that later slide out of the live window
 * stay visible from the loaded history; for messages in both, the live copy (fresher state) wins.
 */
export function mergeHistory<M extends { id: string; pending?: boolean }>(full: readonly M[] | null, live: readonly M[]): M[] {
  if (!full) return [...live];
  const fresh = new Map(live.map(m => [m.id, m]));
  const known = new Set(full.map(m => m.id));
  return [...full.filter(m => !m.pending).map(m => fresh.get(m.id) ?? m), ...live.filter(m => !known.has(m.id) || m.pending)];
}
