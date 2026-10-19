import { describe, expect, it } from 'vitest';
import type { AgentBubble } from '../../shared/team-status';
import { bubbleText } from './bubble-copy';

const bubble = (over: Partial<AgentBubble>): AgentBubble => ({
  agent_id: 'article_production', kind: 'working', reason: 'working', count: 1, peer_agent_id: '', at: '', ...over,
});
const names = (id: string) => ({ content_production: 'Editor-in-Chief', content_review: 'Reviewer' }[id] ?? 'Teammates');

describe('Bubble copy', () => {
  it('uses singular labels for one task or article', () => {
    expect(bubbleText(bubble({ count: 1 }), names)).toBe('Writing · 1 Task');
    expect(bubbleText(bubble({ reason: 'teammate_working', peer_agent_id: 'content_review', count: 1 }), names)).toBe('Waiting for Reviewer · 1 article');
  });
  it('speaks of each Agent in its own work unit and names the teammate involved', () => {
    expect(bubbleText(bubble({ count: 12 }), names)).toBe('Writing · 12 Tasks');
    expect(bubbleText(bubble({ agent_id: 'content_review', kind: 'just_done', reason: 'delivered', count: 8 }), names)).toBe('Reviewed 8 Tasks');
    expect(bubbleText(bubble({ agent_id: 'content_production', kind: 'waiting_on_teammate', reason: 'teammate_working', peer_agent_id: 'content_review', count: 3 }), names)).toBe('Waiting for Reviewer · 3 articles');
    expect(bubbleText(bubble({ kind: 'waiting_on_teammate', reason: 'awaiting_assignment', peer_agent_id: 'content_production', count: 2 }), names)).toBe('2 articles submitted · waiting for Editor-in-Chief');
  });

  it('falls back to generic words for an Agent or reason it does not know yet', () => {
    expect(bubbleText(bubble({ agent_id: 'new_agent', count: 2 }), names)).toBe('Busy · 2 Tasks');
    expect(bubbleText(bubble({ kind: 'stuck', reason: 'something_new' as AgentBubble['reason'] }), names)).toBe('Stuck');
  });
});
