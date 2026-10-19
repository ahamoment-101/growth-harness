import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schemaTestDb } from '../schema-test-db';
import { handleApplicationAuth } from './http';
import { createSession, sessionCookie } from './session';
import { changePassword, hashPassword, ownerPrincipal, passwordPrincipal, verifyPassword } from './password';
import { verifySignedJson } from './crypto';
import { claimPrimaryWorkspace, linkGoogleIdentity } from './store';

const setupToken = 'initialization-token-for-local-test-only';
function fixture() {
  const db = schemaTestDb();
  const env = { DB: db.db, AUTH_SETUP_TOKEN: setupToken } as Env;
  const call = async (path: string, input?: unknown, cookie?: string, extra?: Record<string, string>) => {
    const request = new Request(`http://localhost${path}`, { method: input === undefined ? 'GET' : 'POST',
      headers: { Origin: 'http://localhost', ...(cookie ? { Cookie: cookie } : {}), ...extra },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    return (await handleApplicationAuth(request, env))!;
  };
  const setup = async () => {
    const response = await call('/api/auth/setup', { email: 'Owner@example.com', password: 'correct test password', setup_token: setupToken });
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  return { ...db, env, call, setup };
}

describe('password login and existing owner interoperability', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('requires initialization authority, preserves sites and closes setup after the first owner', async () => {
    const f = fixture();
    f.insert('sites', { id: 'original-site', name: 'Original', workspace_id: 'primary-workspace' });
    expect((await f.call('/api/auth/setup', { email: 'owner@example.com', password: 'correct test password', setup_token: 'wrong' })).status).toBe(403);
    expect((await f.call('/api/auth/me').then(r => r.json()) as any).setup_required).toBe(true);
    const cookie = await f.setup();
    const state = await f.call('/api/auth/me', undefined, cookie).then(r => r.json()) as any;
    expect(state).toMatchObject({ authenticated: true, required: true, setup_required: false, methods: ['password'], password_set: true });
    expect(state.user.email).toBe('owner@example.com');
    expect(f.sqlite.prepare('select id,workspace_id from sites').all()).toEqual([{ id: 'original-site', workspace_id: 'primary-workspace' }]);
    expect((await f.call('/api/auth/setup', { setup_token: setupToken })).status).toBe(409);
    expect(f.sqlite.prepare('select password_hash from auth_password_credentials').get()).not.toEqual({ password_hash: 'correct test password' });
  });

  it('logs in, changes the password, revokes all old sessions and logs out the replacement session', async () => {
    const f = fixture();
    const original = await f.setup();
    const login = await f.call('/api/auth/password/login', { email: 'owner@example.com', password: 'correct test password' });
    expect(login.status).toBe(200);
    const other = login.headers.get('set-cookie')!.split(';')[0];
    expect((await f.call('/api/auth/password/login', { email: 'owner@example.com', password: 'wrong' })).status).toBe(401);
    expect((await f.call('/api/auth/password', { current_password: 'wrong', password: 'replacement test password' }, original)).status).toBe(403);
    const changed = await f.call('/api/auth/password', { current_password: 'correct test password', password: 'replacement test password' }, original);
    expect(changed.status).toBe(200);
    for (const cookie of [original, other]) expect((await f.call('/api/auth/me', undefined, cookie).then(r => r.json()) as any).authenticated).toBe(false);
    expect((await f.call('/api/auth/password/login', { email: 'owner@example.com', password: 'correct test password' })).status).toBe(401);
    const current = changed.headers.get('set-cookie')!.split(';')[0];
    expect((await f.call('/api/auth/logout', {}, current)).status).toBe(200);
    expect((await f.call('/api/auth/me', undefined, current).then(r => r.json()) as any).authenticated).toBe(false);
  });

  it('adds a password to the original Google owner and links Google to a local owner without changing identity', async () => {
    const f = fixture();
    const identity = { sub: 'original-google-sub', email: 'owner@example.com', emailVerified: true, name: 'Owner', picture: '' };
    const owner = await claimPrimaryWorkspace(f.db, identity, identity.email);
    const token = await createSession(f.db, owner);
    const cookie = sessionCookie(new URL('http://localhost'), token).split(';')[0];
    expect((await f.call('/api/auth/password', { password: 'correct test password' }, cookie)).status).toBe(200);
    expect((await ownerPrincipal(f.db))!.user.id).toBe(owner.user.id);
    expect((await f.call('/api/auth/password/login', { email: identity.email, password: 'correct test password' })).status).toBe(200);

    const local = fixture(); await local.setup();
    const localOwner = (await ownerPrincipal(local.db))!;
    await linkGoogleIdentity(local.db, localOwner, identity, identity.email);
    const google = await claimPrimaryWorkspace(local.db, identity, identity.email);
    expect(google.user.id).toBe(localOwner.user.id);
    expect(local.sqlite.prepare('select count(*) as count from app_users').get()).toEqual({ count: 1 });
  });

  it('never merges a password account just because Google reports the same email', async () => {
    const f = fixture(); await f.setup(); const owner = await ownerPrincipal(f.db);
    await expect(claimPrimaryWorkspace(f.db, { sub: 'new-google', email: 'owner@example.com', emailVerified: true, name: '', picture: '' }, 'owner@example.com')).rejects.toThrow();
    expect((await ownerPrincipal(f.db))!.user.id).toBe(owner!.user.id);
  });

  it('enforces disabled methods, Google configuration errors, CSRF and attempt limits before password work', async () => {
    const f = fixture();
    expect((await f.call('/api/auth/login')).status).toBe(404);
    expect((await f.call('/api/auth/setup', {}, undefined, { Origin: 'http://attacker.invalid' })).status).toBe(403);
    for (let i = 0; i < 20; i++) expect((await f.call('/api/auth/password/login', {})).status).toBe(400);
    expect((await f.call('/api/auth/password/login', {})).status).toBe(429);
    f.env.AUTH_LOGIN_METHODS = 'password,google';
    expect((await f.call('/api/auth/me')).status).toBe(503);
    f.env.AUTH_LOGIN_METHODS = 'google';
    Object.assign(f.env, { AUTH_GOOGLE_CLIENT_ID: 'test', AUTH_GOOGLE_CLIENT_SECRET: 'test', AUTH_SESSION_SECRET: 'test', AUTH_ALLOWED_GOOGLE_EMAIL: 'owner@example.com' });
    expect((await f.call('/api/auth/password/login', {})).status).toBe(404);
    expect((await f.call('/api/auth/login')).status).toBe(302);
    expect((await f.call('/api/auth/google/link')).status).toBe(401);
  });

  it('bounds request bodies even without a Content-Length header and safely rejects malformed cookies', async () => {
    const f = fixture();
    expect((await f.call('/api/auth/password/login', { password: 'x'.repeat(9000) })).status).toBe(413);
    const state = await f.call('/api/auth/me', undefined, 'blog_agent_session_dev=%invalid').then(r => r.json()) as any;
    expect(state.authenticated).toBe(false);
  });

  it('uses independently salted hashes and rejects malformed or oversized password inputs', async () => {
    const first = await hashPassword('correct test password');
    const second = await hashPassword('correct test password');
    expect(first).not.toBe(second);
    expect(await verifyPassword('correct test password', first)).toBe(true);
    expect(await verifyPassword('wrong', first)).toBe(false);
    expect(await verifyPassword('correct test password', 'scrypt$broken')).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow(/12/);
  });

  it('does not issue a new session from a password receipt invalidated by a concurrent password change', async () => {
    const f = fixture(); await f.setup();
    const receipt = (await passwordPrincipal(f.db, 'owner@example.com', 'correct test password'))!;
    await changePassword(f.db, receipt, 'correct test password', 'new concurrent password');
    await expect(createSession(f.db as unknown as D1Database, receipt, new Date(), receipt.passwordHash)).rejects.toThrow(/password changed/);
    expect(f.sqlite.prepare("select count(*) as count from auth_sessions where revoked_at=''").get()).toEqual({ count: 0 });
  });

  it('completes signed Google linking and subsequent Google login into the same password-owned workspace', async () => {
    const f = fixture(); const ownerCookie = await f.setup();
    const original = (await ownerPrincipal(f.db))!;
    Object.assign(f.env, { AUTH_LOGIN_METHODS: 'password,google', AUTH_GOOGLE_CLIENT_ID: 'fixture-client',
      AUTH_GOOGLE_CLIENT_SECRET: 'fixture-client-secret', AUTH_ALLOWED_GOOGLE_EMAIL: 'owner@example.com', AUTH_SESSION_SECRET: 'fixture-signing-secret' });
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const publicKey = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'auth-http-fixture', alg: 'RS256' };
    let idToken = '';
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (String(input).includes('/token')) return Response.json({ access_token: 'synthetic-access', id_token: idToken });
      if (String(input).includes('/certs')) return Response.json({ keys: [publicKey] });
      if (String(input).includes('/userinfo')) return Response.json({ sub: 'http-google-sub', email: 'owner@example.com', email_verified: true, name: 'Owner', picture: '' });
      throw new Error('Unexpected network request in OAuth fixture');
    }));
    async function callback(path: string, cookie?: string) {
      const start = await f.call(path, undefined, cookie);
      expect(start.status).toBe(302);
      const oauthCookie = start.headers.get('set-cookie')!.split(';')[0];
      const signed = decodeURIComponent(oauthCookie.slice(oauthCookie.indexOf('=') + 1));
      const state = (await verifySignedJson<{ state: string; nonce: string }>(signed, f.env.AUTH_SESSION_SECRET!))!;
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const payload = `${encode({ alg: 'RS256', kid: 'auth-http-fixture' })}.${encode({ iss: 'https://accounts.google.com', aud: 'fixture-client', sub: 'http-google-sub', nonce: state.nonce, exp: Math.floor(Date.now() / 1000) + 300 })}`;
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(payload));
      idToken = `${payload}.${Buffer.from(signature).toString('base64url')}`;
      return f.call(`/api/auth/google/callback?code=synthetic&state=${state.state}`, undefined, [cookie, oauthCookie].filter(Boolean).join('; '));
    }
    const linked = await callback('/api/auth/google/link', ownerCookie);
    expect(linked.status).toBe(302);
    expect(linked.headers.get('location')).toBe('/account');
    const login = await callback('/api/auth/login');
    expect(login.status).toBe(302);
    const state = await f.call('/api/auth/me', undefined, login.headers.get('set-cookie')!.split(';')[0]).then(r => r.json()) as any;
    expect(state.user.id).toBe(original.user.id);
    expect(state.workspace.id).toBe(original.workspace.id);
    expect(state.google_linked).toBe(true);
    expect(state.password_set).toBe(true);
  });
});
