-- Rebuildable presentation cache. Never business or Agent execution truth.
create table site_ledger_snapshots (
  workspace_id text not null,
  site_id text not null,
  payload_json text,
  computed_at integer not null default 0,
  lease_token text not null default '',
  lease_until integer not null default 0,
  retry_after integer not null default 0,
  primary key(workspace_id, site_id),
  foreign key(workspace_id, site_id) references sites(workspace_id, id) on delete cascade
);
create index keyword_library_ledger on keyword_library_entries(workspace_id, site_id, kind, archived, created_at);
