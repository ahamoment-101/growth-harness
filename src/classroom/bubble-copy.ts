import type { AgentBubble, BubbleKind, BubbleReason } from '../../shared/team-status';

// Every word a status bubble says lives here. The Worker only sends meaning (kind, reason,
// count, teammate); change the wording in this file without touching anything else.

/** How an Agent's own work is counted and spoken of. Agents not listed use DEFAULT_WORK. */
type Work = { unit: string; doing: string; done: string };

const DEFAULT_WORK: Work = { unit: 'item', doing: 'Busy', done: 'Done' };

const WORK: Record<string, Partial<Work>> = {
  strategy_research: { unit: 'market', doing: 'Researching' },
  deep_research: { unit: 'research item', doing: 'Researching' },
  keyword_research: { unit: 'market', doing: 'Researching' },
  topic_decision: { unit: 'topic round', doing: 'Selecting topics' },
  content_production: { unit: 'group', doing: 'Coordinating' },
  article_production: { unit: 'article', doing: 'Writing', done: 'Finished writing' },
  content_review: { unit: 'article', doing: 'Reviewing', done: 'Reviewed' },
};

const work = (agentId: string): Work => ({ ...DEFAULT_WORK, ...WORK[agentId] });
const countedWork = (b: AgentBubble, agentId = b.agent_id) => `${b.count} ${work(agentId).unit}${b.count === 1 ? '' : 's'}`;
const taskCount = (count: number) => `${count} ${count === 1 ? 'Task' : 'Tasks'}`;

type Say = (b: AgentBubble, names: (agentId: string) => string) => string;

const REASONS: Record<BubbleReason, Say> = {
  work_request: (b) => b.count > 1 ? `${b.count} items waiting for you to handle` : 'awaiting your action',
  review_articles: (b) => `${b.count} ${b.count === 1 ? 'article' : 'articles'} waiting for your review`,
  confirm_topic_group: (b) => `${b.count} ${b.count === 1 ? 'topic group' : 'topic groups'} waiting for your confirmation`,
  provide_input: (b) => (b.count > 1 ? `${countedWork(b)} waiting for you to handle` : 'awaiting your action'),
  agent_blocked: () => 'Could not be completed',
  execution_halted: () => 'Execution interrupted',
  teammate_working: (b, names) => `Waiting for ${names(b.peer_agent_id)} · ${countedWork(b, b.peer_agent_id)}`,
  awaiting_assignment: (b, names) => `${countedWork(b)} submitted · waiting for ${names(b.peer_agent_id)}`,
  external_result: (b) => (b.count > 1 ? `${countedWork(b)} waiting on external results` : 'Waiting for external results'),
  recovering: () => 'Resuming Execution',
  waiting_assignment: (b, names) => `Waiting for ${names(b.peer_agent_id)} to assign work`,
  working: (b) => `${work(b.agent_id).doing} · ${taskCount(b.count)}`,
  finished: () => 'This round has ended · View results',
  delivered: (b) => `${work(b.agent_id).done} ${taskCount(b.count)}`,
};

/** Used when the Worker sends a reason this file has no words for yet. */
const KINDS: Record<BubbleKind, string> = {
  needs_you: 'awaiting your action',
  stuck: 'Stuck',
  waiting_on_teammate: 'Waiting for teammates',
  waiting_external: 'Waiting for external results',
  working: 'Working',
  just_done: 'Just completed',
};

export function bubbleText(bubble: AgentBubble, names: (agentId: string) => string): string {
  const say = REASONS[bubble.reason] as Say | undefined;
  return say ? say(bubble, names) : KINDS[bubble.kind] ?? '';
}
