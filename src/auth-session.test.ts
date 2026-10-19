import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSessionAfterDisconnect, redirectToLogin } from './auth-session';

afterEach(() => vi.unstubAllGlobals());

function location(pathname = '/website/s1') {
  const replace = vi.fn();
  vi.stubGlobal('window', { location: { pathname, search: '?agent=strategy_research', hash: '#history', replace } });
  return replace;
}

describe('console session expiry', () => {
  it('redirects to login preserving the interrupted route', () => {
    const replace = location();
    redirectToLogin();
    expect(replace).toHaveBeenCalledWith('/login?return_to=%2Fwebsite%2Fs1%3Fagent%3Dstrategy_research%23history');
  });

  it('does not redirect the login page back to itself', () => {
    const replace = location('/login');
    redirectToLogin();
    expect(replace).not.toHaveBeenCalled();
  });

  it('coalesces disconnect checks and redirects an expired session even in report-only mode', async () => {
    const replace = location();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ authenticated: false, required: false }));
    vi.stubGlobal('fetch', fetchMock);
    const first = checkSessionAfterDisconnect();
    expect(checkSessionAfterDisconnect()).toBe(first);
    expect(await first).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it.each(['authenticated', 'network', 'server', 'malformed'])('keeps reconnecting after %s without assuming logout', async kind => {
    const replace = location();
    vi.stubGlobal('fetch', kind === 'network'
      ? vi.fn().mockRejectedValue(new Error('offline'))
      : vi.fn().mockResolvedValue(kind === 'server'
        ? new Response('', { status: 503 })
        : kind === 'malformed' ? new Response('invalid json') : Response.json({ authenticated: true })));
    expect(await checkSessionAfterDisconnect()).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
});
