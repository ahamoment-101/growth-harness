-- Daily GSC search analytics snapshots, one row per site+date+dimension+key
create table if not exists gsc_analytics (
  id text primary key,
  site_id text not null,
  date text not null,           -- YYYY-MM-DD
  dimension text not null,      -- 'query' | 'page'
  key text not null,            -- the keyword or URL
  clicks integer not null default 0,
  impressions integer not null default 0,
  ctr real not null default 0,
  position real not null default 0,
  fetched_at text not null default ''
);

create index if not exists idx_gsc_analytics_site_date on gsc_analytics(site_id, date);
create index if not exists idx_gsc_analytics_lookup on gsc_analytics(site_id, dimension, date);

-- Daily totals (aggregated per site+date for fast trend charts)
create table if not exists gsc_daily (
  id text primary key,
  site_id text not null,
  date text not null,           -- YYYY-MM-DD
  clicks integer not null default 0,
  impressions integer not null default 0,
  ctr real not null default 0,
  position real not null default 0,
  fetched_at text not null default ''
);

create unique index if not exists idx_gsc_daily_site_date on gsc_daily(site_id, date);
