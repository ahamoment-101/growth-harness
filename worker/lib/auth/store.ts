import type { AppUser, Workspace } from '../../types';

export const PRIMARY_WORKSPACE_ID = 'primary-workspace';

export type VerifiedGoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string;
};

export type AppPrincipal = {
  user: AppUser;
  workspace: Workspace;
};

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function userIdForGoogleSub(sub: string): Promise<string> {
  return `google-${(await sha256Hex(sub)).slice(0, 32)}`;
}

export function assertAllowedGoogleIdentity(identity: VerifiedGoogleIdentity, allowedEmail: string): void {
  if (!identity.emailVerified) throw new Error('Google account email is not verified');
  if (!identity.sub.trim()) throw new Error('Google account subject is missing');
  if (!allowedEmail.trim()) throw new Error('AUTH_ALLOWED_GOOGLE_EMAIL is not configured');
  if (normalizeEmail(identity.email) !== normalizeEmail(allowedEmail)) {
    throw new Error('Google account is not allowed');
  }
}

export async function claimPrimaryWorkspace(
  db: D1Database,
  identity: VerifiedGoogleIdentity,
  allowedEmail: string,
  at = new Date().toISOString(),
): Promise<AppPrincipal> {
  assertAllowedGoogleIdentity(identity, allowedEmail);
  const existing = await db.prepare('select * from app_users where google_sub=?').bind(identity.sub).first<AppUser>();
  if (existing) {
    const workspace = await db.prepare('select * from workspaces where id=?').bind(PRIMARY_WORKSPACE_ID).first<Workspace>();
    if (workspace?.owner_user_id !== existing.id) throw new Error('Primary workspace is owned by another account');
    await db.prepare('update app_users set last_login_at=? where id=?').bind(at, existing.id).run();
    return { user: { ...existing, last_login_at: at }, workspace };
  }
  const userId = await userIdForGoogleSub(identity.sub);
  const email = normalizeEmail(identity.email);

  await db.batch([
    db.prepare(
      `insert into app_users (
        id, google_sub, email, display_name, avatar_url, created_at, last_login_at
      ) select ?, ?, ?, ?, ?, ?, ? from workspaces
      where id=? and (owner_user_id='' or owner_user_id=?)
      on conflict(id) do update set
        email = excluded.email,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        last_login_at = excluded.last_login_at`,
    ).bind(userId, identity.sub, email, identity.name, identity.picture, at, at, PRIMARY_WORKSPACE_ID, userId),
    db.prepare(
      `update workspaces
       set owner_user_id = ?, name = case when owner_user_id = '' then 'My Workspace' else name end
       where id = ? and (owner_user_id = '' or owner_user_id = ?)`,
    ).bind(userId, PRIMARY_WORKSPACE_ID, userId),
    db.prepare(`update sites set workspace_id=? where workspace_id=''
      and exists(select 1 from workspaces where id=? and owner_user_id=?)`)
      .bind(PRIMARY_WORKSPACE_ID, PRIMARY_WORKSPACE_ID, userId),
  ]);

  const workspace = await db.prepare('select * from workspaces where id = ?').bind(PRIMARY_WORKSPACE_ID).first<Workspace>();
  if (!workspace || workspace.owner_user_id !== userId) throw new Error('Primary workspace is owned by another account');
  const user = await db.prepare('select * from app_users where id = ?').bind(userId).first<AppUser>();
  if (!user) throw new Error('Application user was not created');
  return { user, workspace };
}

/** Linking requires an existing authenticated owner; email equality never grants account ownership. */
export async function linkGoogleIdentity(db: D1Database, principal: AppPrincipal, identity: VerifiedGoogleIdentity, allowedEmail: string): Promise<AppPrincipal> {
  assertAllowedGoogleIdentity(identity, allowedEmail);
  const result = await db.prepare(`update app_users set google_sub=? where id=?
    and (google_sub like 'local:%' or google_sub=?)
    and exists(select 1 from workspaces where id=? and owner_user_id=?)`)
    .bind(identity.sub, principal.user.id, identity.sub, principal.workspace.id, principal.user.id).run();
  if (!result.meta.changes) throw new Error('Google identity is already bound or workspace ownership changed');
  return { ...principal, user: { ...principal.user, google_sub: identity.sub } };
}

export async function getWorkspaceSite(db: D1Database, workspaceId: string, siteId: string) {
  return db.prepare('select * from sites where workspace_id = ? and id = ?')
    .bind(workspaceId, siteId)
    .first<import('../../types').Site>();
}

export async function listWorkspaceSites(db: D1Database, workspaceId: string) {
  const { results } = await db.prepare('select * from sites where workspace_id = ? order by created_at desc')
    .bind(workspaceId)
    .all<import('../../types').Site>();
  return results ?? [];
}
