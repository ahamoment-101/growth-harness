-- One row per (published article, target locale) localization request.
-- status: running | failed | done. The localized version itself lives in jobs.versions_json.
create table if not exists article_localizations (
  id text primary key,
  site_id text not null,
  job_id text not null,
  locale text not null,
  status text not null,
  workflow_id text not null default '',
  error text not null default '',
  created_at text not null,
  updated_at text not null
);
create unique index if not exists article_localizations_job_locale on article_localizations(job_id, locale);
create index if not exists article_localizations_site on article_localizations(site_id);
