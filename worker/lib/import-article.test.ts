import { describe, expect, it } from 'vitest';
import { normalizeImportArticle } from './import-article';

function base(overrides: Record<string, unknown> = {}) {
  return {
    locale: 'en',
    title: ' How to GrowTomatoes ',
    slug: 'How-to-Grow-Tomatoes',
    excerpt: ' A short excerpt ',
    content: '# Hello\n\nWorld',
    category: ' METHOD ',
    ...overrides,
  };
}

describe('normalizeImportArticle', () => {
  it('trims fields and lowercases the slug', () => {
    const imported = normalizeImportArticle(base());
    expect(imported).toEqual({
      locale: 'en',
      title: 'How to GrowTomatoes',
      slug: 'how-to-grow-tomatoes',
      excerpt: 'A short excerpt',
      content: '# Hello\n\nWorld',
      category: 'METHOD',
    });
  });

  it('keeps optional fields empty', () => {
    const imported = normalizeImportArticle({ locale: 'fr', title: 'T', slug: 't', content: 'C' });
    expect(imported.excerpt).toBe('');
    expect(imported.category).toBe('');
  });

  it('rejects missing required fields', () => {
    expect(() => normalizeImportArticle(base({ locale: '' }))).toThrow('locale is required');
    expect(() => normalizeImportArticle(base({ title: '' }))).toThrow('title, slug and content are required');
    expect(() => normalizeImportArticle(base({ slug: '' }))).toThrow('title, slug and content are required');
    expect(() => normalizeImportArticle(base({ content: '' }))).toThrow('title, slug and content are required');
  });

  it('rejects non-kebab-case slugs', () => {
    expect(() => normalizeImportArticle(base({ slug: 'Has Spaces' }))).toThrow('slug must be lowercase kebab-case');
    expect(() => normalizeImportArticle(base({ slug: 'has_underscore' }))).toThrow('slug must be lowercase kebab-case');
    expect(() => normalizeImportArticle(base({ slug: '-leading' }))).toThrow('slug must be lowercase kebab-case');
  });

  it('accepts valid kebab-case slugs', () => {
    expect(() => normalizeImportArticle(base({ slug: 'a-1-b-2' }))).not.toThrow();
  });

  it('enforces length caps on optional fields', () => {
    expect(() => normalizeImportArticle(base({ category: 'x'.repeat(101) }))).toThrow('category is too long');
    expect(() => normalizeImportArticle(base({ excerpt: 'x'.repeat(2001) }))).toThrow('excerpt is too long');
    expect(() => normalizeImportArticle(base({ title: 'x'.repeat(501) }))).toThrow('title is too long');
    expect(() => normalizeImportArticle(base({ locale: 'x'.repeat(21) }))).toThrow('locale is too long');
  });

  it('treats non-string fields as empty', () => {
    expect(() => normalizeImportArticle(base({ title: 42 }))).toThrow('title, slug and content are required');
  });
});
