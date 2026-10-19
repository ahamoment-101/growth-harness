-- Keep historical mixed-language groups unassigned. Preserve cascading items and all IDs.
pragma defer_foreign_keys = on;
create table _scope_preserve_results as select * from topic_decision_results;
create table _scope_preserve_items as select * from topic_decision_items;
drop table topic_decision_results;
CREATE TABLE topic_decision_results (
  id text primary key,
  workspace_id text not null,
  site_id text not null references sites(id) on delete cascade,
  run_id text not null,
  submission_operation_id text not null,
  strategy_version_id text references seo_strategy_versions(id),
  strategy_version integer not null,
  decision_type text not null check (decision_type in ('topic_group', 'needs_research')),
  status text not null check (status in ('draft', 'rejected', 'handed_off', 'research_needed')),
  group_goal text not null default '',
  rationale text not null default '',
  group_hypothesis text not null default '',
  expected_signals_json text not null default '[]',
  risks_json text not null default '[]',
  unknowns_json text not null default '[]',
  previous_group_relationship text not null default '',
  research_request_json text not null default '{}',
  web_evidence_json text not null default '[]',
  requested_count integer not null,
  locales_json text not null default '[]',
  reviewed_by text not null default '',
  review_note text not null default '',
  reviewed_at text not null default '',
  created_at text not null,
  updated_at text not null
, language_decisions_json text not null default '[]', scope_locale text, scope_market text,
  check ((scope_locale is null and scope_market is null) or (scope_locale is not null and scope_market is not null and length(scope_locale)>0 and length(scope_market)>0)));

insert into topic_decision_results(id,workspace_id,site_id,run_id,strategy_version_id,strategy_version,decision_type,status,group_goal,rationale,group_hypothesis,expected_signals_json,risks_json,unknowns_json,previous_group_relationship,research_request_json,web_evidence_json,requested_count,locales_json,reviewed_by,review_note,reviewed_at,created_at,updated_at,language_decisions_json,submission_operation_id) select id,workspace_id,site_id,run_id,strategy_version_id,strategy_version,decision_type,status,group_goal,rationale,group_hypothesis,expected_signals_json,risks_json,unknowns_json,previous_group_relationship,research_request_json,web_evidence_json,requested_count,locales_json,reviewed_by,review_note,reviewed_at,created_at,updated_at,language_decisions_json,submission_operation_id from _scope_preserve_results;
insert or ignore into topic_decision_items select * from _scope_preserve_items;
drop table _scope_preserve_items;
drop table _scope_preserve_results;
create unique index topic_decision_results_submission_operation on topic_decision_results(submission_operation_id);
create index topic_decision_results_history_idx on topic_decision_results(workspace_id,site_id,created_at desc);
create index topic_decision_results_scope_idx on topic_decision_results(workspace_id,site_id,scope_locale,scope_market,created_at desc);
-- Individual historical topics may already have explicit item language/market facts.
-- Copy those facts only; do not assign a scope to their legacy mixed-language group.
update topics set plan_json=json_set(plan_json,
  '$.locale',(select i.locale from topic_decision_items i where i.id=topics.decision_item_id),
  '$.market',(select lower(i.market) from topic_decision_items i where i.id=topics.decision_item_id))
where json_extract(plan_json,'$.locale') is null and exists(
  select 1 from topic_decision_items i where i.id=topics.decision_item_id and length(i.locale)>0 and length(i.market)>0
);
pragma defer_foreign_keys = off;
