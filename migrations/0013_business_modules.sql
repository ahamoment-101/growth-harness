-- Domain-level business foundation. Every module is independently versioned so
-- future scans can write the same contract without overwriting manual history.
create table if not exists business_module_versions (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  module_key text not null,
  version integer not null,
  schema_version integer not null default 1,
  content_json text not null default '{}',
  source text not null default 'manual',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (site_id, module_key, version)
);
create index if not exists idx_business_modules_latest
  on business_module_versions(site_id, module_key, version desc);
