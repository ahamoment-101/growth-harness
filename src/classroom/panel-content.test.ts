import { describe, expect, it } from 'vitest';
import type { AgentPanelDetail } from '../../shared/agent-panel';
import { panelDocuments, panelTaskTitle } from './panel-content';
const detail = (content: unknown, status = 'running', output: unknown = {}) => ({
  task: { status, outcome: '', updated_at: 'now' }, draft: { content, updatedAt: 'now' }, output,
}) as AgentPanelDetail;
describe('Agent panel documents', () => {
  it('omits empty drafts and keeps distinct strategy deliverables', () => {
    expect(panelDocuments(detail({ blueprint: {}, keywords: [] }))).toEqual([]);
    expect(panelDocuments(detail({ blueprint: { roadmap: 'Explore demand' }, keywords: ['learn English'] })).map(x => x.title)).toEqual(['SEO Strategy', 'Keyword List']);
  });
  it('keeps language-version identities stable as documents are added', () => {
    const first = panelDocuments(detail({ bundle: { versions: [{ locale: 'en', title: 'First draft', content: 'Draft' }] } }));
    const next = panelDocuments(detail({ bundle: { versions: [{ locale: 'pt', title: 'Português', content: 'Texto' }, { locale: 'en', title: 'Edited title', content: 'More text' }] } }));
    expect(next.find(x => x.id === first[0].id)?.title).toBe('Edited title');
  });
  it('excludes task receipts from products and never marks an incomplete task draft final', () => {
    const value = detail('Saved text', 'completed', { summary: 'Delivered' });
    expect(panelDocuments(value).map(x => x.title)).toEqual(['Working draft']);
    value.task.outcome = 'unable_to_complete';
    expect(panelDocuments(value)[0].status).toBe('Working draft');
  });
  it('turns internal strategy instance labels into readable task titles', () => {
    expect(panelTaskTitle({ agent_id: 'strategy_research', agent_instance_id: 'strategy:pt-BR' } as AgentPanelDetail['task'])).toContain('Portuguese');
    expect(panelTaskTitle({ agent_id: 'deep_research', agent_instance_id: 'child-uuid', display_title: 'In-Depth Topic Research · User Needs' } as AgentPanelDetail['task'])).toBe('In-Depth Topic Research · User Needs');
    expect(panelTaskTitle({ agent_id: 'content_production', agent_instance_id: 'content:123e4567-e89b-12d3-a456-426614174000' } as AgentPanelDetail['task'])).toBe('Create content group');
  });
});
