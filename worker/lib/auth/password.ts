import { Buffer } from 'node:buffer';
import { scrypt, timingSafeEqual, randomBytes } from 'node:crypto';
import { PRIMARY_WORKSPACE_ID, type AppPrincipal } from './store.ts';
import type { AppUser, Workspace } from '../../types';
import { sha256 } from './crypto.ts';

// scrypt's N=2^15, r=8, p=3 costs ~32 MiB per verification. Persist its version and parameters.
const COST = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const PREFIX = 'scrypt$32768$8$3';

function derive(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, COST, (error, key) => error ? reject(error) : resolve(key)));
}

export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 12 || new TextEncoder().encode(password).length > 1024) {
    throw new AuthError('The password must be at least 12 characters and no more than 1024 bytes', 400);
  }
}

export function normalizeLoginEmail(input: unknown): string {
  if (typeof input !== 'string' || input.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim())) {
    throw new AuthError('Please enter a valid email address', 400);
  }
  return input.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  return `${PREFIX}$${Buffer.from(salt).toString('hex')}$${Buffer.from(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== PREFIX || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{64}$/.test(parts[5])) return false;
  const actual = await derive(password, Buffer.from(parts[4], 'hex'));
  return timingSafeEqual(actual, Buffer.from(parts[5], 'hex'));
}

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function ownerPrincipal(db: D1Database): Promise<AppPrincipal | null> {
  const workspace = await db.prepare('select * from workspaces where id=?').bind(PRIMARY_WORKSPACE_ID).first<Workspace>();
  if (!workspace?.owner_user_id) return null;
  const user = await db.prepare('select * from app_users where id=?').bind(workspace.owner_user_id).first<AppUser>();
  if (!user) throw new AuthError('The admin record is incomplete; please contact the deployer', 503);
  return { user, workspace };
}

export async function createPasswordOwner(db: D1Database, emailInput: unknown, passwordInput: unknown): Promise<AppPrincipal & { passwordHash: string }> {
  const email = normalizeLoginEmail(emailInput);
  validatePassword(passwordInput);
  const passwordHash = await hashPassword(passwordInput);
  const id = `local-${crypto.randomUUID()}`;
  const at = new Date().toISOString();
  // Conditional writes are in one D1 transaction. Concurrent setup cannot create a second owner or orphan account.
  await db.batch([
    db.prepare("update workspaces set owner_user_id=?, name='My Workspace' where id=? and owner_user_id=''").bind(id, PRIMARY_WORKSPACE_ID),
    db.prepare(`insert into app_users(id,google_sub,email,display_name,avatar_url,created_at,last_login_at)
      select ?,?,?,?,'',?,? from workspaces where id=? and owner_user_id=?`)
      .bind(id, `local:${id}`, email, email, at, at, PRIMARY_WORKSPACE_ID, id),
    db.prepare(`insert into auth_password_credentials(user_id,password_hash,updated_at)
      select ?,?,? from workspaces where id=? and owner_user_id=?`).bind(id, passwordHash, at, PRIMARY_WORKSPACE_ID, id),
  ]);
  const owner = await ownerPrincipal(db);
  if (owner?.user.id !== id) throw new AuthError('Admin has been created, please log in', 409);
  return { ...owner, passwordHash };
}

export async function passwordPrincipal(db: D1Database, email: string, password: string): Promise<(AppPrincipal & { passwordHash: string }) | null> {
  const owner = await ownerPrincipal(db);
  const credential = owner ? await db.prepare('select password_hash from auth_password_credentials where user_id=?').bind(owner.user.id).first<{ password_hash: string }>() : null;
  // Equal hashing work for unknown accounts. No distinction between wrong email and wrong password in the response.
  const dummy = `${PREFIX}$${'00'.repeat(16)}$${'00'.repeat(32)}`;
  const valid = await verifyPassword(password, credential?.password_hash || dummy);
  return valid && owner?.user.email === email && credential ? { ...owner, passwordHash: credential.password_hash } : null;
}

export async function changePassword(db: D1Database, principal: AppPrincipal, current: string, next: unknown) {
  validatePassword(next);
  const previous = await db.prepare('select password_hash from auth_password_credentials where user_id=?').bind(principal.user.id).first<{ password_hash: string }>();
  if (previous && !await verifyPassword(current, previous.password_hash)) throw new AuthError('Current password is incorrect', 403);
  const hash = await hashPassword(next);
  const at = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`insert into auth_password_credentials(user_id,password_hash,updated_at) select ?,?,? from workspaces where id=? and owner_user_id=?
      on conflict(user_id) do update set password_hash=excluded.password_hash,updated_at=excluded.updated_at
      where auth_password_credentials.password_hash=?`).bind(principal.user.id, hash, at, principal.workspace.id, principal.user.id, previous?.password_hash || ''),

  ]);
  if (!results[0].meta.changes) throw new AuthError('The account status has changed; please log in again and retry', 409);
  return hash;
}

export async function consumeAuthAttempt(db: D1Database, request: Request, action: string, at = Date.now()): Promise<void> {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const key = `${action}:${await sha256(ip)}`;
  const window = Math.floor(at / 600_000);
  const row = await db.prepare(`insert into auth_attempt_windows(key,window_start,attempts) values(?,?,1)
    on conflict(key) do update set window_start=excluded.window_start,
      attempts=case when window_start=excluded.window_start then attempts+1 else 1 end
    where window_start!=excluded.window_start or attempts<20 returning attempts`).bind(key, window).first();
  if (!row) throw new AuthError('Too many attempts; please retry in 10 minutes', 429);
  await db.prepare('delete from auth_attempt_windows where window_start<?').bind(window - 144).run();
}
