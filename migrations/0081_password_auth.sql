-- Credentials attach to the existing user. Workspaces, sites and Google identities are preserved.
create table auth_password_credentials (
  user_id text primary key references app_users(id) on delete cascade,
  password_hash text not null,
  updated_at text not null
);

-- Atomic fixed-window limits bound unauthenticated password and setup work before hashing.
create table auth_attempt_windows (
  key text primary key,
  window_start integer not null,
  attempts integer not null
);

-- A deployer's offline reset and the HTTP password change share atomic session revocation.
create trigger auth_password_insert_revoke after insert on auth_password_credentials
BEGIN
  update auth_sessions set revoked_at=new.updated_at where user_id=new.user_id and revoked_at='';
END;
create trigger auth_password_update_revoke after update of password_hash on auth_password_credentials
BEGIN
  update auth_sessions set revoked_at=new.updated_at where user_id=new.user_id and revoked_at='';
END;
