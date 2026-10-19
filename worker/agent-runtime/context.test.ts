import { describe, expect, it } from 'vitest';
import {
  assembleContext,
  boundedContextValue,
  missingContextSourceIds,
  renderAssembledContextValues,
  serializedContextBytes,
} from './context';
import { agentDefinition } from './definitions';
import { STRATEGY_CONTEXT_BYTE_CAPS, boundedBusinessModules } from './strategy-context';
import { CONTENT_CONTEXT_BYTE_CAPS } from './content-production';

describe('agent context assembly', () => {
  it('creates stable hashes independent of object key order', async () => {
    const first = await assembleContext([{ sourceId: 'site', version: '1', capturedAt: 'now', priority: 10, value: { b: 2, a: 1 } }]);
    const second = await assembleContext([{ sourceId: 'site', version: '1', capturedAt: 'now', priority: 10, value: { a: 1, b: 2 } }]);
    expect(first.manifestHash).toBe(second.manifestHash);
  });

  it('drops lower priority sources when the context budget is exceeded', async () => {
    const result = await assembleContext([
      { sourceId: 'critical', version: '1', capturedAt: 'now', priority: 10, value: 'important' },
      { sourceId: 'optional', version: '1', capturedAt: 'now', priority: 1, value: 'x'.repeat(1000) },
    ], 100);
    expect(result.values).toHaveProperty('critical');
    expect(result.values).not.toHaveProperty('optional');
    expect(result.truncated).toBe(true);
  });

  it('redacts secrets before hashing or returning context', async () => {
    const result = await assembleContext([{ sourceId: 'x', version: '1', capturedAt: 'now', priority: 1, value: { api_key: 'secret' } }]);
    expect(result.values).toEqual({ x: { api_key: '[redacted]' } });
  });

  it('preserves a long article body while applying the shared context budget once', async () => {
    const body = 'Full body paragraph.'.repeat(8_000);
    const result = await assembleContext([
      { sourceId: 'article', version: '1', capturedAt: 'now', priority: 10, value: { body } },
    ], 200_000);
    expect((result.values.article as { body: string }).body).toBe(body);
    expect(result.manifest[0].bytes).toBeGreaterThan(body.length);
  });

  it('reports definition sources removed by context budgeting', () => {
    expect(missingContextSourceIds(
      ['site_state', 'business_modules', 'strategy_history'],
      [{ source_id: 'site_state' }, { source_id: 'business_modules' }],
    )).toEqual(['strategy_history']);
  });

  it('keeps every Agent context cap table under its definition budget', () => {
    // `assembleContext` drops a source that does not fit and `durable-workflow`
    // fails the Run when a required source was dropped — and every declared
    // source is required. Bounding each source at load time keeps that failure
    // unreachable, so this arithmetic is the actual guard: if it breaks, a Run
    // dies at context assembly with no way to recover.
    const sum = (caps: Record<string, number>) => Object.values(caps).reduce((total, value) => total + value, 0);
    expect(sum(STRATEGY_CONTEXT_BYTE_CAPS))
      .toBeLessThan(agentDefinition('strategy_research').contextBudgetBytes);
    expect(CONTENT_CONTEXT_BYTE_CAPS.content_group)
      .toBeLessThan(agentDefinition('content_production').contextBudgetBytes);
    expect(CONTENT_CONTEXT_BYTE_CAPS.article_task)
      .toBeLessThan(agentDefinition('article_production').contextBudgetBytes);
    expect(CONTENT_CONTEXT_BYTE_CAPS.content_review_task)
      .toBeLessThan(agentDefinition('content_review').contextBudgetBytes);
  });

  it('keeps every business module readable when one of them is oversized', () => {
    // The confirmed business foundation is the only context source research
    // cannot reconstruct. Bounding the six modules as one value meant a single
    // long section collapsed all six into an unreadable preview, silently
    // removing the product, audience and conversion facts along with it.
    const modules = ['product', 'audience', 'brand', 'competition', 'marketing', 'conversion'].map((key, index) => ({
      key, content: {}, markdown: key === 'competition' ? 'Competi'.repeat(40_000) : `${key} content`,
      version: index + 1, schema_version: 1, source: 'manual', updated_at: '',
    }));
    const bounded = boundedBusinessModules(modules as never, STRATEGY_CONTEXT_BYTE_CAPS.business_modules) as Array<{
      key: string; markdown: unknown;
    }>;
    expect(serializedContextBytes(bounded)).toBeLessThanOrEqual(STRATEGY_CONTEXT_BYTE_CAPS.business_modules);
    // Every module is still individually addressable, and the intact ones are
    // untouched rather than swallowed by their oversized sibling.
    expect(bounded.map((item) => item.key)).toEqual(['product', 'audience', 'brand', 'competition', 'marketing', 'conversion']);
    expect(bounded.find((item) => item.key === 'product')?.markdown).toBe('product content');
    // The one that overflowed says so, because a silently shortened section
    // reads exactly like a section the customer left thin.
    expect(bounded.find((item) => item.key === 'competition')?.markdown).toMatchObject({ truncated: true });
  });

  it('gives the business foundation room for a thoroughly filled account', () => {
    // Six modules of substantial Unicode prose is an ordinary customer, not an
    // extreme one, and it used to overflow the old cap outright.
    const modules = ['product', 'audience', 'brand', 'competition', 'marketing', 'conversion'].map((key, index) => ({
      key, content: {}, markdown: '\u00e9'.repeat(2_700),
      version: index + 1, schema_version: 1, source: 'manual', updated_at: '',
    }));
    const bounded = boundedBusinessModules(modules as never, STRATEGY_CONTEXT_BYTE_CAPS.business_modules) as Array<{
      markdown: unknown;
    }>;
    expect(bounded.every((item) => typeof item.markdown === 'string')).toBe(true);
  });

  it('bounds an oversized source in place and says so, instead of dropping it', async () => {
    const huge = { rows: Array.from({ length: 400 }, (_, index) => ({ index, text: 'y'.repeat(200) })) };
    const bounded = boundedContextValue(huge, 4_000);
    expect(serializedContextBytes(bounded)).toBeLessThanOrEqual(4_000);
    expect(bounded).toMatchObject({ truncated: true });

    const assembled = await assembleContext([
      { sourceId: 'big', version: '1', capturedAt: '', priority: 100, value: bounded },
      { sourceId: 'small', version: '1', capturedAt: '', priority: 50, value: { ok: true } },
    ], 60_000);
    // Both survive assembly, and the manifest and the rendered prompt both say
    // which one was shortened.
    expect(assembled.manifest.map((item) => item.source_id)).toEqual(['big', 'small']);
    expect(assembled.manifest.find((item) => item.source_id === 'big')?.truncated).toBe(true);
    expect(assembled.manifest.find((item) => item.source_id === 'small')?.truncated).toBe(false);
    expect(renderAssembledContextValues(assembled.values)).toContain('[context:big truncated=true]');
    expect(renderAssembledContextValues(assembled.values)).toContain('[context:small]');
  });
});
