import type { BubbleKind, BubbleReason } from '../../shared/team-status';
import type { TeamSignal } from './signals';

/** The part of an Agent Task the bubble rules read. */
export type TaskFact = {
  seen?: number;
  id: string;
  agent_id: string;
  status: string;
  outcome: string;
  parent_task_id: string;
  parent_agent_id: string;
  updated_at: string;
};

type TaskRule = {
  kind: BubbleKind;
  reason: BubbleReason;
  match: (task: TaskFact) => boolean;
  /** One signal per returned teammate; without it the task yields one signal with no peer. */
  peers?: (task: TaskFact) => string[];
};

const isChild = (task: TaskFact) => task.parent_task_id !== '';

/**
 * How one Task reads as a bubble. The first matching rule wins; a Task no rule matches
 * (cancelled, for example) shows nothing. Rules only read Runtime state — they never
 * judge the business — so a new Agent needs no rule of its own.
 */
export const TASK_RULES: readonly TaskRule[] = [
  { kind: 'working', reason: 'recovering', match: (task) => task.status === 'running' && task.outcome === 'execution_recovering' },
  { kind: 'working', reason: 'working', match: (task) => task.status === 'running' },
  // A saved submission is a notification; once read the underlying wait remains.
  { kind: 'just_done', reason: 'delivered', match: (task) => task.status === 'waiting' && isChild(task) && ['submitted', 'reviewed'].includes(task.outcome) && !task.seen },
  // A waiting child needs its parent; waiting alone does not prove delivery.
  {
    kind: 'waiting_on_teammate', reason: 'waiting_assignment',
    match: (task) => task.status === 'waiting' && isChild(task),
    peers: (task) => [task.parent_agent_id],
  },
  // A waiting top-level task continues only when a person resumes it or provides input.
  { kind: 'needs_you', reason: 'provide_input', match: (task) => task.status === 'waiting' },
  { kind: 'waiting_external', reason: 'external_result', match: (task) => task.status === 'paused' && task.outcome === 'external_pending' },
  { kind: 'stuck', reason: 'execution_halted', match: (task) => task.status === 'paused' && task.outcome === 'execution_failed' },
  // Any other pause was the Agent's own decision to stop at a blocker.
  { kind: 'stuck', reason: 'agent_blocked', match: (task) => task.status === 'paused' },
  { kind: 'stuck', reason: 'execution_halted', match: (task) => task.status === 'failed' },
  // A child's result goes to its parent, which decides what to do with it; only a top-level
  // Agent that gave up is stuck.
  { kind: 'stuck', reason: 'agent_blocked', match: (task) => task.status === 'completed' && !isChild(task) && task.outcome === 'unable_to_complete' },
  { kind: 'just_done', reason: 'finished', match: (task) => task.status === 'completed' },
];

export function taskSignals(tasks: readonly TaskFact[], rules: readonly TaskRule[] = TASK_RULES): TeamSignal[] {
  return tasks.flatMap((task) => {
    const rule = rules.find((candidate) => candidate.match(task));
    if (!rule) return [];
    const peers = rule.peers ? rule.peers(task) : [''];
    return peers.map((peer) => ({ task_id: task.id, agent_id: task.agent_id, kind: rule.kind, reason: rule.reason, count: 1, peer_agent_id: peer, at: task.updated_at }));
  });
}
