-- Versioned SEO strategy research. Narrative lives in Markdown documents;
-- stable identities and executable relationships stay queryable for the loop.

create table if not exists seo_strategy_runs (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  trigger text not null default 'manual',
  instruction text not null default '',
  status text not null default 'running',
  phase text not null default 'reading_business',
  workflow_id text not null default '',
  model text not null default '',
  error text not null default '',
  summary_json text not null default '{}',
  started_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at text not null default ''
);
create index if not exists idx_seo_strategy_runs_site
  on seo_strategy_runs(site_id, started_at desc);

create table if not exists seo_strategy_versions (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  run_id text not null references seo_strategy_runs(id) on delete cascade,
  version integer not null,
  status text not null default 'draft',
  change_summary text not null default '',
  business_snapshot_json text not null default '{}',
  research_scope_json text not null default '{}',
  source_locale text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique(site_id, version)
);
create index if not exists idx_seo_strategy_versions_site
  on seo_strategy_versions(site_id, version desc);

create table if not exists seo_strategy_documents (
  id text primary key,
  strategy_version_id text not null references seo_strategy_versions(id) on delete cascade,
  doc_type text not null,
  body_md text not null default '',
  content_hash text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique(strategy_version_id, doc_type)
);
create index if not exists idx_seo_strategy_documents_version
  on seo_strategy_documents(strategy_version_id, doc_type);

create table if not exists seo_research_sources (
  id text primary key,
  strategy_version_id text not null references seo_strategy_versions(id) on delete cascade,
  source_type text not null default 'web',
  url text not null default '',
  title text not null default '',
  query text not null default '',
  locale text not null default '',
  market text not null default '',
  status text not null default 'ok',
  observation_md text not null default '',
  metadata_json text not null default '{}',
  observed_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index if not exists idx_seo_research_sources_version
  on seo_research_sources(strategy_version_id, source_type);

create table if not exists seo_topic_territories (
  id text primary key,
  strategy_version_id text not null references seo_strategy_versions(id) on delete cascade,
  territory_key text not null,
  name text not null,
  priority_band text not null default 'medium',
  status text not null default 'active',
  audience_summary text not null default '',
  search_job_summary text not null default '',
  business_goal text not null default '',
  conversion_goal text not null default '',
  summary text not null default '',
  sort_order integer not null default 0,
  unique(strategy_version_id, territory_key)
);
create index if not exists idx_seo_topic_territories_version
  on seo_topic_territories(strategy_version_id, priority_band, sort_order);

create table if not exists seo_keyword_clusters (
  id text primary key,
  strategy_version_id text not null references seo_strategy_versions(id) on delete cascade,
  territory_id text not null references seo_topic_territories(id) on delete cascade,
  cluster_key text not null,
  name text not null,
  priority_band text not null default 'medium',
  status text not null default 'active',
  strategic_role text not null default '',
  recommended_hub text not null default '',
  conversion_goal text not null default '',
  summary text not null default '',
  sort_order integer not null default 0,
  unique(strategy_version_id, cluster_key)
);
create index if not exists idx_seo_keyword_clusters_version
  on seo_keyword_clusters(strategy_version_id, territory_id, sort_order);

create table if not exists seo_keywords (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  term text not null,
  normalized_term text not null,
  locale text not null default '',
  market text not null default '',
  lifecycle_status text not null default 'candidate',
  first_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique(site_id, normalized_term, locale, market)
);
create index if not exists idx_seo_keywords_site_status
  on seo_keywords(site_id, lifecycle_status, last_seen_at desc);

create table if not exists seo_strategy_keywords (
  id text primary key,
  strategy_version_id text not null references seo_strategy_versions(id) on delete cascade,
  keyword_id text not null references seo_keywords(id) on delete cascade,
  cluster_id text not null references seo_keyword_clusters(id) on delete cascade,
  intent text not null default '',
  journey_stage text not null default '',
  serp_shape text not null default '',
  recommended_page_type text not null default '',
  business_relevance text not null default '',
  conversion_route text not null default '',
  priority_band text not null default 'medium',
  priority_rationale text not null default '',
  coverage_status text not null default 'uncovered',
  decision text not null default 'include',
  existing_url text not null default '',
  evidence_summary text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique(strategy_version_id, keyword_id)
);
create index if not exists idx_seo_strategy_keywords_version
  on seo_strategy_keywords(strategy_version_id, cluster_id, priority_band, decision);

create table if not exists seo_keyword_sources (
  strategy_keyword_id text not null references seo_strategy_keywords(id) on delete cascade,
  source_id text not null references seo_research_sources(id) on delete cascade,
  evidence_type text not null default 'web',
  note text not null default '',
  primary key(strategy_keyword_id, source_id)
);
