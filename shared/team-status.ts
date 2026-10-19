// What each team member shows above its head in the classroom: at most one bubble, the newest
// unresolved or unread item about that Agent. The Worker decides the meaning (kind, reason, count,
// peer); the console decides the words and icon, so copy changes never touch the Worker.

/** Bubble kinds; their order only breaks exact timestamp ties. An Agent with nothing to show has no bubble. */
export const BUBBLE_KINDS = ['needs_you', 'stuck', 'waiting_on_teammate', 'waiting_external', 'working', 'just_done'] as const;
export type BubbleKind = (typeof BUBBLE_KINDS)[number];

/** Why a bubble has its kind. New reasons may appear before the console has copy for them. */
export type BubbleReason =
  | 'work_request' // needs_you: a durable human request
  | 'review_articles' // needs_you: articles awaiting publication review
  | 'confirm_topic_group' // needs_you: a proposed topic group awaiting confirmation
  | 'provide_input' // needs_you: a top-level task waiting for a person to resume it
  | 'agent_blocked' // stuck: the Agent reported it could not continue
  | 'execution_halted' // stuck: execution stopped and the system will not resume it by itself
  | 'teammate_working' // waiting_on_teammate: its child Agents are still working (peer = child)
  | 'awaiting_assignment' // waiting_on_teammate: delivered, waiting for its parent (peer = parent)
  | 'external_result' // waiting_external: an external service has not returned yet
  | 'recovering'
  | 'waiting_assignment'
  | 'working'
  | 'finished'
  | 'delivered'; // just_done: work finished since the last time a person looked

export type AgentBubble = {
  task_id?: string;
  agent_id: string;
  kind: BubbleKind;
  reason: BubbleReason;
  /** How many things this bubble stands for (tasks, articles, topic groups…, per reason). */
  count: number;
  /** The teammate involved, for the waiting_on_teammate reasons; '' otherwise. */
  peer_agent_id: string;
  /** Latest time among the things counted. */
  at: string;
};

export type TeamStatus = { bubbles: AgentBubble[]; figures: { working: number; pending: number } };
