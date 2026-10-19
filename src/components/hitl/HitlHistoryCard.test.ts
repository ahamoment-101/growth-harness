import { createElement } from 'react';
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HitlHistoryCard } from './HitlHistoryCard';
import type { WorkNode } from '../../../shared/agent-work';

it('keeps the submitted decision and original question available inside a collapsed summary', () => {
  const node: WorkNode = {
    id: 'hitl:one', at: '2026-09-25T05:43:00Z', title: 'Confirm next batch of topic proposals', state: 'resolved',
    interaction: {
      id: 'hitl:one', version: '1', state: 'resolved', fields: [], actions: [],
      spec: {
        schema_version: 1, title: 'Confirm next batch of topic proposals', description: 'Select two to continue production.',
        blocks: [{ type: 'choice', id: 'topic', label: 'Topic', required: true, options: [
          { value: 'first', label: 'First piece' }, { value: 'second', label: 'Second piece' },
        ] }],
        actions: [{ id: 'confirm', label: 'Continue in recommended order', tone: 'primary', required_fields: ['topic'] }],
      },
      response: { action: 'confirm', label: 'Continue in recommended order', values: { topic: 'first' }, note: 'Response saved', at: '2026-09-25T05:45:00Z' },
    },
  };
  const html = renderToStaticMarkup(createElement(HitlHistoryCard, { node }));
  expect(html).toContain('<details class="hitl-history">');
  expect(html).toContain('Confirm next batch of topic proposals');
  expect(html).toContain('Continue in recommended order');
  expect(html).toContain('Select two to continue production.');
  expect(html).toContain('✓ First piece');
  expect(html).toContain('Response saved');
});
