import { afterEach, describe, expect, it, vi } from 'vitest';
import { librarySource } from './source';

afterEach(() => vi.unstubAllGlobals());

describe('keyword library source', () => {
  it('reads persisted data even when an old URL and browser preference request fixtures', async () => {
    vi.stubGlobal('location', { search: '?data=mock' });
    const getItem = vi.fn(() => 'mock');
    vi.stubGlobal('sessionStorage', { getItem, setItem: vi.fn() });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ languages: [] }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await librarySource().languages('site-1')).toEqual({ languages: [] });
    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site-1/keyword-library/languages', expect.objectContaining({ credentials: 'same-origin' }));
    expect(getItem).not.toHaveBeenCalled();
  });

  it('preserves scoped filters and pagination when reading real entries', async () => {
    const page = { items: [], next: null };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(page));
    vi.stubGlobal('fetch', fetchMock);

    expect(await librarySource().entries('site/1', { locale: 'fr' }, {
      kind: 'keyword', query: 'support guides', parent_id: 'cluster-1', archived: true, after: 'cursor-1',
    })).toEqual(page);
    const request = new URL(fetchMock.mock.calls[0][0], 'https://example.invalid');
    expect(request.pathname).toBe('/api/sites/site%2F1/keyword-library/entries');
    expect(Object.fromEntries(request.searchParams)).toEqual({
      locale: 'fr', kind: 'keyword', query: 'support guides', parent_id: 'cluster-1', archived: 'true', after: 'cursor-1',
    });
  });

  it('propagates an API failure instead of replacing it with sample records', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Library unavailable' }, { status: 503 })));
    await expect(librarySource().languages('site-1')).rejects.toThrow('Library unavailable');
  });
});
