-- Optional, isolated customer Header/Nav/Footer synchronization.
-- Existing sites and render paths remain unchanged until a preview version is enabled.
create table if not exists brand_shell_settings (
  site_id text primary key references sites(id) on delete cascade,
  status text not null default 'disabled' check (status in ('disabled', 'preview', 'enabled')),
  active_version_id text,
  preview_version_id text,
  source_url text not null default '',
  source_etag text not null default '',
  source_last_modified text not null default '',
  source_fingerprint text not null default '',
  rejected_fingerprint text not null default '',
  last_checked_at text not null default '',
  next_check_at text not null default '',
  sync_lease_until text not null default '',
  last_error text not null default '',
  created_at text not null,
  updated_at text not null
);

create table if not exists brand_shell_versions (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  source_url text not null,
  source_fingerprint text not null,
  source_etag text not null default '',
  source_last_modified text not null default '',
  schema_version integer not null default 1,
  shell_json text not null,
  created_by text not null check (created_by in ('manual', 'auto')),
  created_at text not null,
  activated_at text not null default '',
  unique(site_id, source_fingerprint)
);

create index if not exists idx_brand_shell_versions_site_created
  on brand_shell_versions(site_id, created_at desc);

create table if not exists brand_shell_sync_runs (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  trigger text not null check (trigger in ('manual', 'visitor')),
  status text not null check (status in ('running', 'succeeded', 'unchanged', 'failed', 'rejected')),
  source_url text not null,
  source_fingerprint text not null default '',
  version_id text not null default '',
  error text not null default '',
  started_at text not null,
  finished_at text not null default ''
);

create index if not exists idx_brand_shell_runs_site_started
  on brand_shell_sync_runs(site_id, started_at desc);
