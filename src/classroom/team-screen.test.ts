import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TeamScreen } from './Screens';
import type { Site } from '../api';
import type { ConfigurationView } from './useLeaderConfiguration';

const render = (configuration: ConfigurationView, working = 0, pending = 0, statusReady = true) => renderToStaticMarkup(createElement(TeamScreen, {
  site: { id: 's' } as Site, headcount: 8, working, pending, configuration, statusReady,
}));

describe('Home team state', () => {
  it('shows setup is required even if an old work count remains', () => {
    const html = render({ state: 'missing', key: 'SELECTED_KEY', message: 'Configure SELECTED_KEY' }, 1);
    expect(html).toContain('Model setup required');
    expect(html).not.toContain('The team is working');
  });
  it('distinguishes idle, active, and awaiting input once configured', () => {
    expect(render({ state: 'configured' })).toContain('The team is idle');
    expect(render({ state: 'configured' }, 1)).toContain('The team is working');
    expect(render({ state: 'configured' }, 0, 1)).toContain('Your input is needed');
  });
  it('does not claim the team is idle or working when configuration or status is unknown', () => {
    expect(render({ state: 'checking' })).toContain('Checking model setup');
    expect(render({ state: 'unavailable' })).toContain('Model setup unknown');
    expect(render({ state: 'configured' }, 1, 0, false)).toContain('Team status unavailable');
  });
});
