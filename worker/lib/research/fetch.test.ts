import { describe, expect, it } from 'vitest';
import { autocompleteUrl } from './fetch';

describe('autocomplete locale targeting', () => {
  it('targets the Run language and region when the locale provides both', () => {
    const url = new URL(autocompleteUrl('melhor tradutor', 'pt-BR'));
    expect(url.searchParams.get('q')).toBe('melhor tradutor');
    expect(url.searchParams.get('hl')).toBe('pt');
    expect(url.searchParams.get('gl')).toBe('br');
  });

  it('does not invent a region for a language-only locale', () => {
    const url = new URL(autocompleteUrl('translation app', 'en'));
    expect(url.searchParams.get('hl')).toBe('en');
    expect(url.searchParams.has('gl')).toBe(false);
  });
});
