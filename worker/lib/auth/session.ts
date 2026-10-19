import type { AppUser } from '../../types';
import { randomToken, sha256 } from './crypto';
import type { AppPrincipal } from './store';

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type SessionRow = AppUser & {
  workspace_id: string;
  workspace_name: string;
  workspace_owner_user_id: string;
  workspace_created_at: string;
};

function cookieName(url: URL, kind: 'session' | 'oauth'): string {
  const production = url.protocol === 'https:';
  if (kind === 'session') return production ? '__Host-blog_agent_session' : 'blog_agent_session_dev';
  return production ? '__Host-blog_agent_oauth' : 'blog_agent_oauth_dev';
}

export function readCookie(request: Request, name: string): string {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(rest.join('=')); } catch { return ''; }
    }
  }
  return '';
}

function cookieSecurity(url: URL): string {
  return url.protocol === 'https:' ? '; Secure' : '';
}

export function oauthCookie(url: URL, value: string, maxAge = 600): string {
  return `${cookieName(url, 'oauth')}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecurity(url)}`;
}

export function clearOauthCookie(url: URL): string {
  return oauthCookie(url, '', 0);
}

export function sessionCookie(url: URL, value: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  return `${cookieName(url, 'session')}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecurity(url)}`;
}

export function clearSessionCookie(url: URL): string {
  return sessionCookie(url, '', 0);
}

export function oauthCookieValue(request: Request): string {
  return readCookie(request, cookieName(new URL(request.url), 'oauth'));
}

export function sessionCookieValue(request: Request): string {
  return readCookie(request, cookieName(new URL(request.url), 'session'));
}

export class SessionChangedError extends Error {}

export async function createSession(db: D1Database, principal: AppPrincipal, at = new Date(), passwordHash?: string): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const createdAt = at.toISOString();
  const expiresAt = new Date(at.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const result = await db.prepare(
    `insert into auth_sessions (
      id, token_hash, user_id, workspace_id, expires_at, last_seen_at, created_at, revoked_at
    ) select ?, ?, ?, ?, ?, ?, ?, ''
      where ? is null or exists(select 1 from auth_password_credentials where user_id=? and password_hash=?)`,
  ).bind(crypto.randomUUID(), tokenHash, principal.user.id, principal.workspace.id, expiresAt, createdAt, createdAt,
    passwordHash ?? null, principal.user.id, passwordHash ?? null).run();
  if (!result.meta.changes) throw new SessionChangedError('The password changed during login; please log in again with the new password');
  return token;
}

export async function authenticateRequest(db: D1Database, request: Request, at = new Date()): Promise<AppPrincipal | null> {
  const token = sessionCookieValue(request);
  if (!token) return null;
  const row = await db.prepare(
    `select
      u.*,
      w.id as workspace_id,
      w.name as workspace_name,
      w.owner_user_id as workspace_owner_user_id,
      w.created_at as workspace_created_at
     from auth_sessions s
     join app_users u on u.id = s.user_id
     join workspaces w on w.id = s.workspace_id and w.owner_user_id = u.id
     where s.token_hash = ? and s.revoked_at = '' and s.expires_at > ?`,
  ).bind(await sha256(token), at.toISOString()).first<SessionRow>();
  if (!row) return null;
  return {
    user: {
      id: row.id,
      google_sub: row.google_sub,
      email: row.email,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      created_at: row.created_at,
      last_login_at: row.last_login_at,
    },
    workspace: {
      id: row.workspace_id,
      name: row.workspace_name,
      owner_user_id: row.workspace_owner_user_id,
      created_at: row.workspace_created_at,
    },
  };
}

export async function revokeSession(db: D1Database, request: Request, at = new Date()): Promise<void> {
  const token = sessionCookieValue(request);
  if (!token) return;
  await db.prepare("update auth_sessions set revoked_at = ? where token_hash = ? and revoked_at = ''")
    .bind(at.toISOString(), await sha256(token))
    .run();
}
