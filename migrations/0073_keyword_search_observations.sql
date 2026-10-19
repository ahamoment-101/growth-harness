-- Search data recorded by the host from a keyword data provider (DataForSEO).
-- Append-only: each lookup adds rows; readers take the latest row per keyword, country and kind.
-- Keyed by keyword text and language rather than library entry, so a keyword keeps its data
-- across revisions, archives and topic groups. request_cost_usd is the whole provider call's
-- cost, shared by every row with the same request_id.
create table if not exists keyword_search_observations (
  id text primary key,
  workspace_id text not null,
  site_id text not null,
  language text not null,
  country text not null,
  keyword_key text not null,
  keyword text not null,
  kind text not null check (kind in ('metrics', 'serp')),
  payload_json text not null,
  source text not null,
  request_id text not null,
  request_cost_usd real not null default 0,
  observed_at text not null
);

create index if not exists idx_keyword_search_latest
  on keyword_search_observations(site_id, language, keyword_key, kind, country, observed_at);
