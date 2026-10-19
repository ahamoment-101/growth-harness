-- A Run owns at most one strategy version, and a site exposes exactly one active strategy.

create unique index if not exists seo_strategy_versions_run_idx
  on seo_strategy_versions (run_id);

create unique index if not exists seo_strategy_versions_one_active_idx
  on seo_strategy_versions (site_id)
  where status = 'active';
