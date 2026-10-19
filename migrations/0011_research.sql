-- Research loop: fact tables (joinable) + versioned understanding docs.
-- Site-level schedule/config lives on sites so the console can set time and trigger.

alter table sites add column research_enabled integer not null default 0;
alter table sites add column research_timezone text not null default 'Asia/Shanghai';
alter table sites add column research_weekday integer not null default 1;
alter table sites add column research_hour integer not null default 9;
alter table sites add column competitor_domains_json text not null default '[]';
alter table sites add column research_seed_terms_json text not null default '[]';
alter table sites add column product_brief text not null default '';

create table if not exists competitors (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  domain text not null,
  brand text not null default '',
  positioning text not null default '',
  source text not null default '',
  first_seen_at text not null default '',
  last_fetched_at text not null default '',
  unique (site_id, domain)
);
create index if not exists idx_competitors_site on competitors(site_id);

create table if not exists competitor_pages (
  id text primary key,
  competitor_id text not null references competitors(id) on delete cascade,
  url text not null,
  title text not null default '',
  keyword_hint text not null default '',
  content_type text not null default '',
  fetched_at text not null default '',
  unique (competitor_id, url)
);
create index if not exists idx_competitor_pages_cid on competitor_pages(competitor_id);

create table if not exists keywords (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  cluster text not null default '',
  term text not null,
  intent text not null default '',
  content_type text not null default '',
  volume_hint text not null default '',
  status text not null default 'candidate',
  source text not null default '',
  evidence text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (site_id, term)
);
create index if not exists idx_keywords_site_status on keywords(site_id, status);

create table if not exists research_docs (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  doc_type text not null,
  version integer not null default 1,
  body text not null default '',
  produced_by text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index if not exists idx_research_docs_site on research_docs(site_id, doc_type, version desc);

create table if not exists research_runs (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  trigger text not null default 'manual',
  status text not null default 'running',
  workflow_id text not null default '',
  error text not null default '',
  summary_json text not null default '{}',
  started_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at text not null default ''
);
create index if not exists idx_research_runs_site on research_runs(site_id, started_at desc);
