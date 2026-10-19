import { describe, expect, it } from 'vitest';
import {
  blockedFrom,
  crawlerHeaders,
  decideIndexing,
  INDEXABLE,
  robotsDirective,
  robotsTxtFor,
} from './indexing';

describe('indexability contract', () => {
  it('lets the preview surface override anything the page claims', () => {
    expect(decideIndexing('preview', INDEXABLE)).toEqual({ indexable: false, reason: 'preview_surface' });
    expect(decideIndexing('preview', blockedFrom('empty_locale'))).toEqual({
      indexable: false,
      reason: 'preview_surface',
    });
  });

  it("keeps a page's own reason on the hosted surface", () => {
    expect(decideIndexing('hosted', INDEXABLE)).toEqual(INDEXABLE);
    expect(decideIndexing('hosted', blockedFrom('setup_page'))).toEqual({
      indexable: false,
      reason: 'setup_page',
    });
  });

  it('keeps follow on blocked pages so crawlers still reach the canonical ones', () => {
    expect(robotsDirective(blockedFrom('not_found'))).toBe('noindex, follow');
  });

  it('opens snippet and image limits explicitly for indexable pages', () => {
    const directive = robotsDirective(INDEXABLE);
    expect(directive).toContain('index, follow');
    expect(directive).toContain('max-image-preview:large');
    expect(directive).toContain('max-snippet:-1');
  });

  it('tags only the preview surface on the wire', () => {
    expect(crawlerHeaders('hosted')).toEqual({});
    expect(crawlerHeaders('preview')).toEqual({ 'X-Robots-Tag': 'noindex, follow' });
  });

  it('closes robots.txt on the preview surface and advertises no sitemap there', () => {
    const hosted = robotsTxtFor('https://blog.example.com/sitemap.xml', 'hosted');
    expect(hosted).toContain('Allow: /');
    expect(hosted).toContain('Sitemap: https://blog.example.com/sitemap.xml');
    const preview = robotsTxtFor('https://worker.example.com/live/site-1/sitemap.xml', 'preview');
    expect(preview).toBe('User-agent: *\nDisallow: /\n');
  });
});
