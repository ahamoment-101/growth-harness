import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, DurableObject: class {} }));
vi.mock('agents', () => ({
  Agent: class {},
  getAgentByName: vi.fn(),
  routeAgentRequest: vi.fn(async () => null),
}));
vi.mock('agents/workflows', () => ({ AgentWorkflow: class {} }));
vi.mock('@cloudflare/ai-chat', () => ({ AIChatAgent: class {} }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let worker: any;

beforeAll(async () => {
  worker = (await import('./index')).default;
});

import { schemaTestDb } from './lib/schema-test-db';
import { createSession, sessionCookie } from './lib/auth/session';
import { ownerPrincipal } from './lib/auth/password';

async function fixture() {
  const f = schemaTestDb();
  f.insert('app_users', { id: 'owner', google_sub: 'local:owner', email: 'owner@example.com' });
  f.sqlite.prepare("update workspaces set owner_user_id='owner' where id='primary-workspace'").run();
  f.insert('sites', { id: 's1', name: 'Example', workspace_id: 'primary-workspace' });
  const token = await createSession(f.db as unknown as D1Database, (await ownerPrincipal(f.db as unknown as D1Database))!);
  const cookie = sessionCookie(new URL('https://console.workers.dev'), token).split(';')[0];
  const env = { DB: f.db, GOOGLE_CLIENT_ID: 'test-client', AUTH_SESSION_SECRET: 'local-state-signing-secret' };
  const call = (path: string, method = 'GET', authenticated = true) => worker.fetch(new Request('https://console.workers.dev'+path,
    { method, headers: { Origin: 'https://console.workers.dev', ...(authenticated ? { Cookie: cookie } : {}) } }), env);
  return { call, env };
}

describe('GSC routes – authenticated HTTP implementation', () => {
  it('redirects the authenticated owner to Google with a signed state', async () => {
    const f = await fixture();
    const response = await f.call('/api/sites/s1/gsc/oauth/start');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.hostname).toBe('accounts.google.com');
    expect(location.searchParams.get('client_id')).toBe('test-client');
    expect(location.searchParams.get('state')).toContain('.');
  });
  it('returns a configuration error only after authenticating the owner', async () => {
    const f = await fixture(); f.env.GOOGLE_CLIENT_ID = '';
    expect((await f.call('/api/sites/s1/gsc/oauth/start')).status).toBe(503);
    expect((await f.call('/api/sites/s1/gsc/oauth/start', 'GET', false)).status).toBe(401);
  });
  it.each(['verify-property', 'submit-sitemap'])('keeps %s site-scoped and requires login', async action => {
    const f = await fixture();
    expect((await f.call(`/api/sites/missing/gsc/${action}`, 'POST')).status).toBe(404);
    expect((await f.call(`/api/sites/s1/gsc/${action}`, 'POST', false)).status).toBe(401);
  });
  it('returns to the console with a readable missing-code result for an authenticated callback', async () => {
    const f = await fixture();
    const response = await f.call('/api/gsc/oauth/callback');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('gsc_error=missing_code');
  });
});
