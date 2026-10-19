-- Give every locale its own business version sequence without rebuilding the
-- referenced parent table. The legacy version column remains an internal,
-- site-wide storage identity because older D1 schemas enforce unique(site_id, version).

alter table seo_strategy_versions add column locale_version integer not null default 0;

update seo_strategy_versions as current
set locale_version = (
  select count(*)
  from seo_strategy_versions as prior
  where prior.site_id = current.site_id
    and prior.source_locale = current.source_locale
    and prior.version <= current.version
)
where locale_version = 0;

create unique index if not exists seo_strategy_versions_locale_version_idx
  on seo_strategy_versions(site_id, source_locale, locale_version);

create index if not exists idx_seo_strategy_versions_site_locale
  on seo_strategy_versions(site_id, source_locale, locale_version desc);
