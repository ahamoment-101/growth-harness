import { describe, expect, it } from 'vitest';
import { BLOG_LAYOUTS, DEFAULT_BLOG_LAYOUT, blogLayoutDef, normalizeBlogLayout } from '../../shared/blog-layouts';

describe('blog layout catalog', () => {
  it('keeps keys unique and always defines the default', () => {
    const keys = new Set(BLOG_LAYOUTS.map((l) => l.key));
    expect(keys.size).toBe(BLOG_LAYOUTS.length);
    expect(keys.has(DEFAULT_BLOG_LAYOUT)).toBe(true);
  });

  it('gives every template a name and description', () => {
    for (const layout of BLOG_LAYOUTS) {
      expect(layout.name.trim()).not.toBe('');
      expect(layout.description.trim()).not.toBe('');
    }
  });
});

describe('normalizeBlogLayout', () => {
  it('accepts known keys and trims whitespace', () => {
    expect(normalizeBlogLayout('magazine')).toBe('magazine');
    expect(normalizeBlogLayout(' magazine ')).toBe('magazine');
  });

  it('falls back on unknown or missing values instead of erroring', () => {
    expect(normalizeBlogLayout('classic')).toBe(DEFAULT_BLOG_LAYOUT);
    expect(normalizeBlogLayout('timeline')).toBe(DEFAULT_BLOG_LAYOUT);
    expect(normalizeBlogLayout('grid-hero')).toBe(DEFAULT_BLOG_LAYOUT);
    expect(normalizeBlogLayout('')).toBe(DEFAULT_BLOG_LAYOUT);
    expect(normalizeBlogLayout(null)).toBe(DEFAULT_BLOG_LAYOUT);
    expect(normalizeBlogLayout(undefined)).toBe(DEFAULT_BLOG_LAYOUT);
    expect(normalizeBlogLayout(42)).toBe(DEFAULT_BLOG_LAYOUT);
    expect(normalizeBlogLayout('bad', 'magazine')).toBe('magazine');
  });

  it('resolves unknown stored keys to the default definition', () => {
    expect(blogLayoutDef('classic').key).toBe(DEFAULT_BLOG_LAYOUT);
    expect(blogLayoutDef('nope')).toBe(BLOG_LAYOUTS[0]);
  });
});
