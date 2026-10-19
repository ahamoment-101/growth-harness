import { expect, it } from 'vitest';
import { strategyInstructions } from './strategy-conversation';

it('builds v38 request instructions without dropping strategy know-how or rewriting pinned versions', () => {
  const current = strategyInstructions(38, 2);
  const pinned = strategyInstructions(37, 2);
  expect(pinned).toContain('Each manual generation request authorizes research');
  expect(current).not.toContain('Each manual generation request');
  expect(current.match(/^## \d+\. .+$/gm)).toEqual([
    '## 1. Mission', '## 2. Requests', '## 3. Business facts and evidence', '## 4. Autonomous work and recovery',
    '## 5. Research selection, commissioning and convergence', '## 6. Strategic judgment', '## 7. SEO playbook know-how',
    '## 8. Blueprint and downstream handoff', '## 9. Persisting revisions', '## 10. Inspection and review', '## 11. Delivering the result',
  ]);
  for (const kept of ['Derive this site\'s own families of search intent', 'Decide page types from what actually ranks', 'Observe search results before recommending a page format', 'Plan internal linking as part of the strategy', 'deep_research studies the market and competition'])
    expect(current).toContain(kept);
  expect(current).toContain('Honor explicit requirements.');
  expect(current).toContain('that the request needs answered;');
  expect(current).toContain('Work that does not change the strategy leaves the draft untouched.');
  expect(current).toContain('judgment_summary briefly states');
});
