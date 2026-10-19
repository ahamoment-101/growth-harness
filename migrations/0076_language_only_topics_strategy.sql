-- Remove the redundant market partition. Existing locale is retained verbatim; no aliases or language inference.

-- Colliding names/operation IDs abort this migration atomically; no record is silently merged or discarded.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE _language_preserve_seo_keyword_sources AS SELECT * FROM seo_keyword_sources;

CREATE TABLE _language_preserve_seo_keywords AS SELECT * FROM seo_keywords;

CREATE TABLE _language_preserve_seo_research_sources AS SELECT * FROM seo_research_sources;

CREATE TABLE _language_preserve_seo_strategy_keywords AS SELECT * FROM seo_strategy_keywords;

CREATE TABLE _language_preserve_topic_decision_items AS SELECT * FROM topic_decision_items;

CREATE TABLE _language_preserve_topic_decision_results AS SELECT * FROM topic_decision_results;

DROP TRIGGER site_changes_topic_result_insert;

DROP TRIGGER site_changes_topic_result_status;

DROP TABLE seo_keywords;

DROP TABLE seo_research_sources;

DROP TABLE topic_decision_items;

DROP TABLE topic_decision_results;

CREATE TABLE seo_keywords (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  term text not null,
  normalized_term text not null,
  locale text not null default '',
  lifecycle_status text not null default 'candidate',
  first_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique(site_id, normalized_term, locale)
);

CREATE TABLE seo_research_sources (
  id text primary key,
  strategy_version_id text not null references seo_strategy_versions(id) on delete cascade,
  source_type text not null default 'web',
  url text not null default '',
  title text not null default '',
  query text not null default '',
  locale text not null default '',
  status text not null default 'ok',
  observation_md text not null default '',
  metadata_json text not null default '{}',
  observed_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE topic_decision_items (
  id text primary key,
  result_id text not null references topic_decision_results(id) on delete cascade,
  strategy_keyword_id text not null,
  keyword_id text not null,
  topic_key text not null,
  title_direction text not null,
  primary_keyword text not null,
  content_type text not null,
  locale text not null,
  search_intent text not null,
  group_role text not null,
  rationale text not null,
  hypothesis text not null,
  evidence_json text not null default '[]',
  relationship_to_existing text not null default '',
  risk text not null default '',
  sort_order integer not null,
  topic_id text references topics(id) on delete set null,
  job_id text references jobs(id) on delete set null,
  created_at text not null, strategy_version_id text references seo_strategy_versions(id), strategy_version integer not null default 0,
  library_keyword_id text references keyword_library_entries(id),
  unique (result_id, sort_order)
);

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
, language_decisions_json text not null default '[]', scope_locale text, research_run_id text not null default '', research_dispatch_error text not null default '', review_operation_id text not null default '');

INSERT INTO seo_keywords(id,site_id,term,normalized_term,locale,lifecycle_status,first_seen_at,last_seen_at) SELECT id,site_id,term,normalized_term,locale,lifecycle_status,first_seen_at,last_seen_at FROM _language_preserve_seo_keywords;

INSERT INTO seo_research_sources(id,strategy_version_id,source_type,url,title,query,locale,status,observation_md,metadata_json,observed_at) SELECT id,strategy_version_id,source_type,url,title,query,locale,status,observation_md,metadata_json,observed_at FROM _language_preserve_seo_research_sources;

INSERT INTO topic_decision_items(id,result_id,strategy_keyword_id,keyword_id,topic_key,title_direction,primary_keyword,content_type,locale,search_intent,group_role,rationale,hypothesis,evidence_json,relationship_to_existing,risk,sort_order,topic_id,job_id,created_at,strategy_version_id,strategy_version,library_keyword_id) SELECT id,result_id,strategy_keyword_id,keyword_id,topic_key,title_direction,primary_keyword,content_type,locale,search_intent,group_role,rationale,hypothesis,evidence_json,relationship_to_existing,risk,sort_order,topic_id,job_id,created_at,strategy_version_id,strategy_version,library_keyword_id FROM _language_preserve_topic_decision_items;

INSERT INTO topic_decision_results(id,workspace_id,site_id,run_id,submission_operation_id,strategy_version_id,strategy_version,decision_type,status,group_goal,rationale,group_hypothesis,expected_signals_json,risks_json,unknowns_json,previous_group_relationship,research_request_json,web_evidence_json,requested_count,locales_json,reviewed_by,review_note,reviewed_at,created_at,updated_at,language_decisions_json,scope_locale,research_run_id,research_dispatch_error,review_operation_id) SELECT id,workspace_id,site_id,run_id,submission_operation_id,strategy_version_id,strategy_version,decision_type,status,group_goal,rationale,group_hypothesis,expected_signals_json,risks_json,unknowns_json,previous_group_relationship,research_request_json,web_evidence_json,requested_count,locales_json,reviewed_by,review_note,reviewed_at,created_at,updated_at,language_decisions_json,scope_locale,research_run_id,research_dispatch_error,review_operation_id FROM _language_preserve_topic_decision_results;

INSERT INTO seo_keyword_sources(strategy_keyword_id,source_id,evidence_type,note) SELECT strategy_keyword_id,source_id,evidence_type,note FROM _language_preserve_seo_keyword_sources p WHERE NOT EXISTS (SELECT 1 FROM seo_keyword_sources x WHERE x.strategy_keyword_id=p.strategy_keyword_id AND x.source_id=p.source_id);

INSERT INTO seo_strategy_keywords(id,strategy_version_id,keyword_id,cluster_id,intent,journey_stage,serp_shape,recommended_page_type,business_relevance,conversion_route,priority_band,priority_rationale,coverage_status,decision,existing_url,evidence_summary,created_at) SELECT id,strategy_version_id,keyword_id,cluster_id,intent,journey_stage,serp_shape,recommended_page_type,business_relevance,conversion_route,priority_band,priority_rationale,coverage_status,decision,existing_url,evidence_summary,created_at FROM _language_preserve_seo_strategy_keywords p WHERE NOT EXISTS (SELECT 1 FROM seo_strategy_keywords x WHERE x.id=p.id);

CREATE INDEX idx_seo_keywords_site_status
  on seo_keywords(site_id, lifecycle_status, last_seen_at desc);

CREATE INDEX idx_seo_research_sources_version
  on seo_research_sources(strategy_version_id, source_type);

CREATE INDEX topic_decision_items_result_idx ON topic_decision_items(result_id,sort_order);

CREATE INDEX topic_decision_items_strategy_idx ON topic_decision_items(strategy_version_id,locale);

CREATE UNIQUE INDEX topic_decision_results_submission_operation on topic_decision_results(submission_operation_id);

CREATE INDEX topic_decision_results_history_idx on topic_decision_results(workspace_id,site_id,created_at desc);

CREATE INDEX topic_decision_results_scope_idx on topic_decision_results(workspace_id,site_id,scope_locale,created_at desc);

CREATE INDEX topic_decision_results_research_dispatch
  on topic_decision_results(status, research_run_id, research_dispatch_error);

CREATE INDEX topic_decision_results_site_status on topic_decision_results(workspace_id,site_id,status,updated_at);

CREATE TRIGGER site_changes_topic_result_insert after insert on topic_decision_results
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref) values(new.workspace_id,new.site_id,'topic_result',new.id);
END;

CREATE TRIGGER site_changes_topic_result_status after update of status on topic_decision_results
when old.status is not new.status
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref) values(new.workspace_id,new.site_id,'topic_result',new.id);
END;

CREATE INDEX topic_decision_results_run on topic_decision_results(run_id);

DROP TABLE _language_preserve_seo_keyword_sources;

DROP TABLE _language_preserve_seo_keywords;

DROP TABLE _language_preserve_seo_research_sources;

DROP TABLE _language_preserve_seo_strategy_keywords;

DROP TABLE _language_preserve_topic_decision_items;

DROP TABLE _language_preserve_topic_decision_results;

-- Mutable plans use their existing language; immutable task histories and receipts stay intact.
UPDATE topics SET plan_json=json_remove(plan_json,'$.market','$.scope.market') WHERE json_valid(plan_json);
UPDATE jobs SET plan_json=json_remove(plan_json,'$.market','$.scope.market') WHERE json_valid(plan_json);

PRAGMA defer_foreign_keys = OFF;
