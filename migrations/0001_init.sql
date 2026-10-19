-- MVP schema: sites (publish targets), topics (queue), jobs (episodes).

create table if not exists sites (
  id text primary key,
  name text not null,
  ingest_url text not null,
  ingest_secret text not null default '',
  secret_header text not null default 'x-ingest-secret',
  locales_json text not null default '["en","pt-BR"]',
  hub_path text not null default '/write-english',
  model text not null default 'runtime-configured',
  min_words integer not null default 400,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists topics (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  topic_key text not null,
  title_hint text not null,
  category text not null,
  primary_keyword text not null,
  status text not null default 'queued',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (site_id, topic_key)
);

create index if not exists topics_site_status_idx
  on topics (site_id, status, created_at);

create table if not exists jobs (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  topic_id text references topics(id) on delete set null,
  status text not null default 'queued',
  translation_group text,
  category text,
  en_slug text,
  en_title text,
  en_excerpt text,
  en_content text,
  pt_slug text,
  pt_title text,
  pt_excerpt text,
  pt_content text,
  qa_report text,
  review_note text,
  workflow_id text,
  error text,
  publish_response text,
  published_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists jobs_site_status_idx
  on jobs (site_id, status, created_at desc);
