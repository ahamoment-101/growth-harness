-- Single-owner application authentication and the first workspace boundary.

create table if not exists app_users (
  id text primary key,
  google_sub text not null unique,
  email text not null unique,
  display_name text not null default '',
  avatar_url text not null default '',
  created_at text not null,
  last_login_at text not null
);

create table if not exists workspaces (
  id text primary key,
  name text not null,
  owner_user_id text not null default '',
  created_at text not null
);

insert or ignore into workspaces (id, name, owner_user_id, created_at)
values ('primary-workspace', 'Primary Workspace', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

alter table sites add column workspace_id text not null default 'primary-workspace';

create index if not exists sites_workspace_created_idx
  on sites (workspace_id, created_at desc);

create table if not exists auth_sessions (
  id text primary key,
  token_hash text not null unique,
  user_id text not null references app_users(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  expires_at text not null,
  last_seen_at text not null,
  created_at text not null,
  revoked_at text not null default ''
);

create index if not exists auth_sessions_user_expiry_idx
  on auth_sessions (user_id, expires_at desc);

