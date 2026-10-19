import { describe, expect, it } from 'vitest';
import { leaderDeliveryView } from './delivery-view';

describe('Leader delivery context', () => {
  it('preserves assignment, member claims, failures and dated artifact references without copying editorial internals', () => {
    const report = { agent: 'content_production', task_ref: 'child', assignment: { created_at: '2026-09-24' },
      result: { outcome: 'completed', judgment_summary: 'Member claim', limitations: ['One item deferred'],
        state: { group: { id: 'group' }, items: [{ job_id: 'article', artifact_id: 'artifact',
          job_created_at: '2026-09-16', published_at: '2026-09-17', review_note: 'Deferred scope',
          parent_review: { evidence_findings: ['Historical editorial detail'] } }] } } };
    const view = leaderDeliveryView(report);
    expect(view).toMatchObject({ task_ref: 'child', assignment: report.assignment,
      result: { outcome: 'completed', judgment_summary: 'Member claim', limitations: ['One item deferred'],
        artifact_observations: [{ job_id: 'article', artifact_id: 'artifact', published_at: '2026-09-17', review_note: 'Deferred scope' }] } });
    expect(JSON.stringify(view)).not.toContain('Historical editorial detail');
    expect(report.result.state.items[0].parent_review.evidence_findings).toHaveLength(1);
    expect(view).not.toHaveProperty('goal_completed');
  });

  it('leaves other member contracts and reports without group observations intact', () => {
    for (const report of [{ agent: 'deep_research', result: { findings: ['Evidence'], sources: ['url'] } },
      { agent: 'content_production', result: { outcome: 'deferred', reason: 'Needs scope' } }]) {
      expect(leaderDeliveryView(report)).toBe(report);
    }
  });
});
