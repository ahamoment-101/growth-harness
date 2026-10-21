import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

it('preserves structured model configuration errors for the Leader UI', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'model_configuration_required', error: 'SELECTED_MODEL_KEY is not set. Configure it and restart.' }, { status: 503 })));
  await expect(api.sendLeaderMessage('s', 'conversation', { id: 'message', text: 'Research my next article' }))
    .rejects.toMatchObject({ code: 'model_configuration_required', status: 503, message: expect.stringContaining('SELECTED_MODEL_KEY') });
});

it('shows rejected credentials as a login error while protected requests still redirect expired sessions', async () => {
  const replace = vi.fn();
  vi.stubGlobal('window', { location: { pathname: '/website/s', search: '', hash: '', replace } });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Incorrect email or password' }, { status: 401 })));
  await expect(api.passwordLogin('owner@example.com', 'incorrect')).rejects.toThrow('Incorrect email or password');
  expect(replace).not.toHaveBeenCalled();
  await expect(api.sites()).rejects.toThrow('Session expired');
  expect(replace).toHaveBeenCalledWith('/login?return_to=%2Fwebsite%2Fs');
});
