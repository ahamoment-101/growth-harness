import { expect, it } from 'vitest';
import { seededVersions } from './demo-content';

it('keeps installation samples explicitly synthetic and scoped to the configured languages and hub', () => {
  const versions = seededVersions(['en', 'pt-BR'], '/customer-help');
  expect(versions.map(version => version.locale)).toEqual(['en', 'pt-BR']);
  expect(new Set(versions.map(version => version.slug)).size).toBe(2);
  expect(versions.every(version => version.content.includes('synthetic installation material') && version.content.includes('](/customer-help)'))).toBe(true);
  expect(versions.every(version => version.excerpt.includes('Replace before publishing'))).toBe(true);
});
