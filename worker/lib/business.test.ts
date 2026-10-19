import { describe, expect, it } from 'vitest';
import { BUSINESS_MODULES, businessModuleMarkdown, contentFromBusinessMarkdown, emptyBusinessModuleContent, normalizeBusinessModuleContent } from '../../shared/business';
import { buildBusinessContext, type BusinessModuleView } from './business';

describe('business modules', () => {
  it('keeps only fields defined by the module contract', () => {
    expect(normalizeBusinessModuleContent('product', { summary: '  A product  ', unknown: 'drop' })).toEqual({
      ...emptyBusinessModuleContent('product'),
      summary: 'A product',
    });
  });

  it('builds an agent-readable context from non-empty modules', () => {
    const modules: BusinessModuleView[] = [{
      key: 'product',
      content: { ...emptyBusinessModuleContent('product'), summary: 'Help teams manage multilingual content.' },
      markdown: '# Product information\n\n## One-sentence introduction\n\nHelp teams manage multilingual content.',
      version: 1,
      schema_version: 1,
      source: 'manual',
      updated_at: '2026-08-21T00:00:00.000Z',
    }];
    const context = buildBusinessContext(modules);
    expect(context).toContain('# Product information');
    expect(context).toContain('One-sentence introduction');
    expect(context).toContain('Help teams manage multilingual content.');
  });

  it('tells agents not to invent facts when the foundation is empty', () => {
    expect(buildBusinessContext([])).toContain('Do not invent product claims');
  });

  it('round-trips predefined Markdown headings into the module contract', () => {
    const markdown = businessModuleMarkdown('product', { summary: 'A product', category: 'Tools' });
    expect(contentFromBusinessMarkdown('product', markdown)).toMatchObject({ summary: 'A product', category: 'Tools' });
  });

  it('keeps late modules available even when earlier fields are very long', () => {
    const modules = BUSINESS_MODULES.map((definition) => ({
      key: definition.key,
      content: Object.fromEntries(definition.fields.map((field) => [field.key, 'A'.repeat(4000)])),
      markdown: '',
      version: 1,
      schema_version: 1,
      source: 'manual',
      updated_at: '2026-08-21T00:00:00.000Z',
    }));
    expect(buildBusinessContext(modules)).toContain('# Conversion Goals');
  });
});
