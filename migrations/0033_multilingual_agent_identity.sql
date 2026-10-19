-- Make locale a first-class business identity for strategy research and topic delivery.

alter table seo_strategy_runs add column source_locale text not null default '';

update seo_strategy_runs
set source_locale = coalesce((select s.source_locale from sites s where s.id = seo_strategy_runs.site_id), '')
where source_locale = '';

drop index if exists seo_strategy_versions_one_active_idx;
create unique index if not exists seo_strategy_versions_one_active_locale_idx
  on seo_strategy_versions (site_id, source_locale)
  where status = 'active';

create index if not exists idx_seo_strategy_runs_site_locale
  on seo_strategy_runs(site_id, source_locale, started_at desc);

alter table topic_decision_results add column language_decisions_json text not null default '[]';
alter table topic_decision_items add column strategy_version_id text references seo_strategy_versions(id);
alter table topic_decision_items add column strategy_version integer not null default 0;

update topic_decision_items
set strategy_version_id = (
      select r.strategy_version_id from topic_decision_results r where r.id = topic_decision_items.result_id
    ),
    strategy_version = (
      select r.strategy_version from topic_decision_results r where r.id = topic_decision_items.result_id
    )
where strategy_version_id is null;

create index if not exists topic_decision_items_strategy_idx
  on topic_decision_items(strategy_version_id, locale);

alter table jobs add column source_locale text not null default '';

update jobs
set source_locale = coalesce((select s.source_locale from sites s where s.id = jobs.site_id), '')
where source_locale = '';
