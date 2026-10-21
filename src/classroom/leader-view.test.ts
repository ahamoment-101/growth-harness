import { describe, expect, it } from 'vitest';
import { conversationPhase, conversationTitle, friendlyError, groupConversations, groupLeaderTasks, mergeHistory, mergeLeaderFeed, relativeTime, taskPhase, titleFromMessage } from './leader-view';
import type { LeaderConversation, LeaderTask } from '../../shared/growth-leader';

const base: LeaderConversation = { id: 'a', title: 'New Conversation', context: '', source_id: '', created_at: '2026-09-21T00:00:00Z', status: 'waiting', reason: '', updated_at: '2026-09-21T00:00:00Z', preview: '', team_active: 0, team_delivered: 0, team_total: 0, pending_inputs: 0 };

describe('leader view', () => {
  it('shows structured model configuration guidance while retaining generic feedback for unclassified errors', () => {
    const error = Object.assign(new Error('SELECTED_MODEL_KEY is not set. Add it to .dev.vars and restart.'), { code: 'model_configuration_required' });
    expect(friendlyError(error, 'Please try again')).toBe(error.message);
    expect(friendlyError(new Error('Internal execution detail'), 'Please try again')).toBe('Please try again');
  });
  it('describes a conversation by what the person should expect next', () => {
    expect(conversationPhase(base).label).toBe('Waiting for your reply');
    expect(conversationPhase({ ...base, pending_inputs: 1 }).label).toBe('Leader is thinking');
    expect(conversationPhase({ ...base, status: 'running' }).label).toBe('Leader is thinking');
    expect(conversationPhase({ ...base, status: 'paused', pending_inputs: 1 }).label).toBe('Paused');
    expect(conversationPhase({ ...base, status: 'running', execution_state: 'recovering', pending_inputs: 1 }).label).toBe('Waiting to retry');
    expect(conversationPhase({ ...base, team_active: 2 }).label).toBe('Team working');
    expect(conversationPhase({ ...base, status: 'ready' }).label).toBe('Not started yet');
    expect(conversationPhase({ ...base, status: 'cancelled', team_active: 1 }).label).toBe('Ended');
    expect(conversationPhase({ ...base, status: 'failed' }).tone).toBe('alert');
  });
  it('puts a pending human decision above the task lifecycle', () => {
    expect(taskPhase({ status: 'running', outcome: '', attention_count: 1 }).label).toBe('Awaiting your confirmation');
    expect(taskPhase({ status: 'completed', outcome: 'unable_to_complete', attention_count: 0 }).label).toBe('Could not be completed');
    expect(taskPhase({ status: 'completed', outcome: 'completed', attention_count: 0 }).label).toBe('Delivered');
  });
  it('shows each agent once while preserving every task and its order', () => {
    const task = (id: string, agent_id: string, created_at: string): LeaderTask => ({ id, agent_id, agent_name: agent_id, status: 'running', outcome: '', reason: '', created_at, updated_at: created_at, display_title: id, goal: '', why: '', attention_count: 0 });
    const groups = groupLeaderTasks([
      task('editor-old', 'content_production', '2026-09-25T01:00:00Z'),
      task('topics', 'topic_decision', '2026-09-25T02:00:00Z'),
      task('editor-new', 'content_production', '2026-09-25T03:00:00Z'),
    ]);
    expect(groups.map(group => [group.agent_id, group.tasks.map(item => item.id)])).toEqual([
      ['content_production', ['editor-new', 'editor-old']],
      ['topic_decision', ['topics']],
    ]);
  });
  it('titles untitled conversations from the first message', () => {
    expect(titleFromMessage('Explore Japan? Check pricing')).toBe('Explore Japan');
    expect(titleFromMessage('Review the plan. Then assign work.')).toBe('Review the plan');
    expect(titleFromMessage('\n  Help me plan the content rhythm and key themes for next month across all languages, especially German')).toBe('Help me plan the content…');
    expect(titleFromMessage('   ')).toBe('New Conversation');
    expect(conversationTitle({ title: 'New Conversation', preview: 'Weekly topics?' })).toBe('Weekly topics');
    expect(conversationTitle({ title: 'Pricing research', preview: 'x' })).toBe('Pricing research');
  });
  it('orders open conversations by latest activity and separates ended ones', () => {
    const list = [{ ...base, id: 'old' }, { ...base, id: 'new', updated_at: '2026-09-21T02:00:00Z' }, { ...base, id: 'done', status: 'completed', updated_at: '2026-09-21T03:00:00Z' }];
    const { open, ended } = groupConversations(list);
    expect(open.map(c => c.id)).toEqual(['new', 'old']);
    expect(ended.map(c => c.id)).toEqual(['done']);
  });
  it('shows short relative times', () => {
    const now = Date.parse('2026-09-21T12:00:00');
    expect(relativeTime('2026-09-21T11:59:40', now)).toBe('Just now');
    expect(relativeTime('2026-09-21T11:30:00', now)).toBe('30 minutes ago');
    expect(relativeTime('2026-09-20T09:05:00', now)).toBe('Yesterday 09:05');
    expect(relativeTime('2026-09-02T09:05:00', now)).toBe('9/2');
  });
  it('keeps loaded history when the live window slides and prefers live copies', () => {
    const full = [{ id: 'a' }, { id: 'b', text: 'old' }, { id: 'c' }, { id: 'p', pending: true }];
    expect(mergeHistory(full, [{ id: 'b', text: 'new' }, { id: 'c' }, { id: 'd' }, { id: 'p', pending: true }]).map(m => m.id)).toEqual(['a', 'b', 'c', 'd', 'p']);
    expect(mergeHistory(full, [{ id: 'b', text: 'new' }])[1]).toEqual({ id: 'b', text: 'new' });
    // The window moved past b and c; they stay visible from the loaded history.
    expect(mergeHistory(full, [{ id: 'd' }, { id: 'e' }]).map(m => m.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(mergeHistory(null, [{ id: 'x' }]).map(m => m.id)).toEqual(['x']);
  });
  it('keeps a resolved HITL card between the surrounding conversation messages', () => {
    const messages = [
      { id: 'before', role: 'assistant' as const, text: 'Please choose', created_at: '2026-09-25T05:42:00Z' },
      { id: 'after', role: 'assistant' as const, text: 'Continuing', created_at: '2026-09-25T05:46:00Z' },
    ];
    const hitl = [{ id: 'hitl:one', at: '2026-09-25T05:43:00Z', title: 'Choose', state: 'resolved' as const }];
    expect(mergeLeaderFeed(messages, hitl).map(item => item.value.id)).toEqual(['before', 'hitl:one', 'after']);
  });
});
