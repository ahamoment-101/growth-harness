import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

it('shows rejected credentials as a login error while protected requests still redirect expired sessions', async () => {
  const replace = vi.fn();
  vi.stubGlobal('window', { location: { pathname: '/website/s', search: '', hash: '', replace } });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Incorrect email or password' }, { status: 401 })));
  await expect(api.passwordLogin('owner@example.com', 'incorrect')).rejects.toThrow('Incorrect email or password');
  expect(replace).not.toHaveBeenCalled();
  await expect(api.sites()).rejects.toThrow('Session expired');
  expect(replace).toHaveBeenCalledWith('/login?return_to=%2Fwebsite%2Fs');
});
