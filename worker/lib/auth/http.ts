import { ConfigurationError, loginConfiguration } from '../../../shared/config/auth';
import { sha256 } from './crypto';
import { createGoogleLogin, exchangeGoogleCode, fetchGoogleIdentity, verifyOAuthState } from './oauth';
import { unsafeOriginError } from './origin';
import { AuthError, changePassword, consumeAuthAttempt, createPasswordOwner, normalizeLoginEmail, ownerPrincipal, passwordPrincipal } from './password';
import { authenticateRequest, clearOauthCookie, clearSessionCookie, createSession, oauthCookie, oauthCookieValue, revokeSession, sessionCookie, SessionChangedError } from './session';
import { claimPrimaryWorkspace, linkGoogleIdentity, type AppPrincipal } from './store';

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

async function signedIn(db: D1Database, principal: AppPrincipal & { passwordHash?: string }, url: URL): Promise<Response> {
  const token = await createSession(db, principal, new Date(), principal.passwordHash);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(url, token) });
}

async function readAuthBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError('Invalid request format', 400);
  const buffer = new Uint8Array(8192);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.length > buffer.length) {
        await reader.cancel();
        throw new AuthError('Request too large', 413);
      }
      buffer.set(chunk.value, length); length += chunk.value.length;
    }
  } finally { reader.releaseLock(); }
  try {
    const body = JSON.parse(new TextDecoder().decode(buffer.subarray(0, length)));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new AuthError('Invalid request format', 400); }
}

export async function handleApplicationAuth(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/auth/')) return null;
  const method = request.method;
  try {
    if (!['GET', 'HEAD'].includes(method)) {
      const originError = unsafeOriginError(request);
      if (originError) return json({ error: originError }, 403);
      if (Number(request.headers.get('content-length') || 0) > 8192) return json({ error: 'Request too large' }, 413);
    }
    // Logout stays available even if the deployment's login configuration is broken.
    if (path === '/api/auth/logout' && method === 'POST') {
      await revokeSession(env.DB, request);
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(url) });
    }
    const config = loginConfiguration(env as unknown as Record<string, unknown>);
    const principal = await authenticateRequest(env.DB, request);
    if (path === '/api/auth/me' && method === 'GET') {
      const owner = await ownerPrincipal(env.DB);
      const password = principal ? await env.DB.prepare('select user_id from auth_password_credentials where user_id=?').bind(principal.user.id).first() : null;
      return json({ authenticated: Boolean(principal), required: true, methods: config.methods,
        setup_required: !owner, setup_available: !owner && (env.AUTH_SETUP_TOKEN?.trim().length || 0) >= 32,
        ...(principal ? { password_set: Boolean(password), google_linked: !principal.user.google_sub.startsWith('local:'),
          user: { id: principal.user.id, email: principal.user.email, name: principal.user.display_name, picture: principal.user.avatar_url },
          workspace: { id: principal.workspace.id, name: principal.workspace.name } } : {}),
      });
    }
    if (path === '/api/auth/setup' || path === '/api/auth/password/login' || path === '/api/auth/password') {
      if (method !== 'POST') return json({ error: 'method not allowed' }, 405);
      if (!config.methods.includes('password')) return json({ error: 'Username and password login is not enabled' }, 404);
      await consumeAuthAttempt(env.DB, request, path);
      const body = await readAuthBody(request);
      if (path === '/api/auth/setup') {
        if (await ownerPrincipal(env.DB)) return json({ error: 'Admin has been created, please log in' }, 409);
        if ((env.AUTH_SETUP_TOKEN?.trim().length || 0) < 32) return json({ error: 'The deployer has not configured the initialization code; please run npm run setup' }, 503);
        const supplied = typeof body.setup_token === 'string' ? body.setup_token : '';
        if (await sha256(supplied) !== await sha256(env.AUTH_SETUP_TOKEN!.trim())) return json({ error: 'Initialization code is incorrect' }, 403);
        return signedIn(env.DB, await createPasswordOwner(env.DB, body.email, body.password), url);
      }
      if (path === '/api/auth/password') {
        if (!principal) return json({ error: 'authentication required' }, 401);
        const passwordHash = await changePassword(env.DB, principal, typeof body.current_password === 'string' ? body.current_password : '', body.password);
        return signedIn(env.DB, { ...principal, passwordHash }, url);
      }
      const email = normalizeLoginEmail(body.email);
      if (typeof body.password !== 'string' || new TextEncoder().encode(body.password).length > 1024) return json({ error: 'Incorrect email or password' }, 401);
      const account = await passwordPrincipal(env.DB, email, body.password);
      if (!account) return json({ error: 'Incorrect email or password' }, 401);
      return signedIn(env.DB, account, url);
    }
    if (path === '/api/auth/login' || path === '/api/auth/google/link' || path === '/api/auth/google/callback') {
      if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
      if (!config.methods.includes('google')) return json({ error: 'Google login is not enabled' }, 404);
      if (path !== '/api/auth/google/callback') {
        const linking = path.endsWith('/link');
        if (linking && !principal) return json({ error: 'authentication required' }, 401);
        const login = await createGoogleLogin({ clientId: env.AUTH_GOOGLE_CLIENT_ID!, secret: env.AUTH_SESSION_SECRET!,
          redirectUri: `${url.origin}/api/auth/google/callback`, returnTo: linking ? '/account' : url.searchParams.get('return_to') || '/',
          ...(linking ? { linkUserId: principal!.user.id } : {}),
        });
        return new Response(null, { status: 302, headers: { Location: login.url, 'Set-Cookie': oauthCookie(url, login.cookieValue), 'Cache-Control': 'no-store' } });
      }
      try {
        const code = url.searchParams.get('code') || '';
        const returnedState = url.searchParams.get('state') || '';
        if (!code || !returnedState) throw new Error('Google OAuth callback is incomplete');
        const state = await verifyOAuthState({ cookieValue: oauthCookieValue(request), returnedState, secret: env.AUTH_SESSION_SECRET! });
        if (state.linkUserId && principal?.user.id !== state.linkUserId) throw new Error('Please log in again as the original admin and then bind Google');
        const tokens = await exchangeGoogleCode({ code, clientId: env.AUTH_GOOGLE_CLIENT_ID!, clientSecret: env.AUTH_GOOGLE_CLIENT_SECRET!, redirectUri: `${url.origin}/api/auth/google/callback`, verifier: state.verifier });
        const identity = await fetchGoogleIdentity(tokens.accessToken, tokens.idToken, state.nonce, env.AUTH_GOOGLE_CLIENT_ID!);
        const account = state.linkUserId
          ? await linkGoogleIdentity(env.DB, principal!, identity, env.AUTH_ALLOWED_GOOGLE_EMAIL!)
          : await claimPrimaryWorkspace(env.DB, identity, env.AUTH_ALLOWED_GOOGLE_EMAIL!);
        const token = await createSession(env.DB, account);
        const headers = new Headers({ Location: state.returnTo, 'Set-Cookie': sessionCookie(url, token), 'Cache-Control': 'no-store' });
        headers.append('Set-Cookie', clearOauthCookie(url));
        return new Response(null, { status: 302, headers });
      } catch (error) {
        // Provider payloads and credentials never become browser-visible diagnostics.
        console.error('[auth] Google login failed', error instanceof Error ? error.message : 'OAuth failure');
        return new Response(null, { status: 302, headers: { Location: `/login?error=${encodeURIComponent('Google login was not completed; please retry or contact the deployer')}`, 'Set-Cookie': clearOauthCookie(url), 'Cache-Control': 'no-store' } });
      }
    }
    return json({ error: 'not found' }, 404);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error('[configuration]', error.message);
      return json({ error: 'Login configuration is incomplete; the deployer should run npm run config:check and complete the configuration or disable the corresponding login method', code: 'configuration_error' }, 503);
    }
    if (error instanceof AuthError) return json({ error: error.message }, error.status);
    if (error instanceof SessionChangedError) return json({ error: error.message }, 409);
    throw error;
  }
}
