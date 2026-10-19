import { describe, expect, it, vi } from 'vitest';
import { handleDevelopmentRequest } from './development-routes';
import { schemaTestDb } from './schema-test-db';
import { API_ROUTE_INVENTORY, accessRequiresPrincipal, classifyConsoleRequest } from './auth/access';

function request(path: string, body: unknown = {}) {
  return new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) });
}

describe('optional synthetic development routes', () => {
  it.each([undefined, '', 'false', 'TRUE', '1'])('returns 404 without reading inputs or touching D1 unless explicitly enabled: %s', async value => {
    const prepare = vi.fn(() => { throw new Error('Disabled routes must not touch D1'); });
    const env = { DEV_TOOLS_ENABLED: value, DB: { prepare } } as unknown as Env;
    await Promise.all(['/api/dev/mock-ingest', '/api/dev/seed-job'].map(async path => {
      const input = request(path);
      const read = vi.spyOn(input, 'json');
      expect((await handleDevelopmentRequest(input, env, 'workspace'))!.status).toBe(404);
      expect(read).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    }));
  });

  it('keeps every fixture route behind existing workspace authentication and origin protection', () => {
    for (const path of ['/api/dev/mock-ingest', '/api/dev/seed-job']) {
      const route = API_ROUTE_INVENTORY.find(item => item.route === path)!;
      expect(route).toMatchObject({ access: 'workspace', originProtected: true });
      expect(accessRequiresPrincipal(classifyConsoleRequest(path), undefined)).toBe(true);
    }
  });

  it('accepts an enabled mock-ingest callback and validates its JSON envelope', async () => {
    const env = { DEV_TOOLS_ENABLED: 'true' } as Env;
    const response = await handleDevelopmentRequest(request('/api/dev/mock-ingest', { dry_run: true, posts: [] }), env, 'workspace');
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true, dry_run: true, received_keys: ['dry_run', 'posts'] });
    expect((await handleDevelopmentRequest(request('/api/dev/mock-ingest', []), env, 'workspace'))!.status).toBe(400);
  });

  it('creates synthetic jobs only for a site owned by the authenticated workspace', async () => {
    const f = schemaTestDb();
    f.insert('sites', { id: 'site', name: 'Example', workspace_id: 'primary-workspace', source_locale: 'en', translate_locales_json: '[]', hub_path: '/help', min_words: 10 });
    const env = { DEV_TOOLS_ENABLED: 'true', DB: f.db } as Env;
    const denied = await handleDevelopmentRequest(request('/api/dev/seed-job', { site_id: 'site' }), env, 'other-workspace');
    expect(denied!.status).toBe(404);
    expect(f.sqlite.prepare('select count(*) as total from jobs').get()).toEqual({ total: 0 });
    const created = await handleDevelopmentRequest(request('/api/dev/seed-job', { site_id: 'site' }), env, 'primary-workspace');
    expect(created!.status).toBe(201);
    expect(f.sqlite.prepare('select site_id from jobs').get()).toEqual({ site_id: 'site' });
    expect(JSON.stringify(await created!.json())).toContain('synthetic installation material');
  });

  it('does not intercept ordinary application paths or unsupported methods', async () => {
    const env = { DEV_TOOLS_ENABLED: 'true' } as Env;
    expect(await handleDevelopmentRequest(request('/api/jobs'), env, 'workspace')).toBeNull();
    expect(await handleDevelopmentRequest(new Request('http://localhost/api/dev/mock-ingest'), env, 'workspace')).toBeNull();
  });
});
