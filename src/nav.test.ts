import { expect, it } from 'vitest';
import { parseRoute } from './nav';

it('opens recorded team progress for legacy static team links', () => {
  expect(parseRoute('/website/site-1/room-team')).toEqual({ page: 'room-activity', siteId: 'site-1' });
  expect(parseRoute('/s/site-1/room-team/')).toEqual({ page: 'room-activity', siteId: 'site-1' });
});

it('preserves the real classroom and agent progress routes', () => {
  expect(parseRoute('/website/site-1')).toEqual({ page: 'classroom', siteId: 'site-1' });
  expect(parseRoute('/website/site-1/room-activity')).toEqual({ page: 'room-activity', siteId: 'site-1' });
});
