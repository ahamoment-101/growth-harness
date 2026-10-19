-- Detach formal artifacts from execution deletion and key submissions by operation.

-- Rebuild the entire affected FK subtree, preserving all rows and indexes.

-- Copies are checked before the temporary backups are removed; no task cleanup occurs here.

pragma defer_foreign_keys=on;

create table _runtime_preserve_agent_memories as select * from agent_memories;

create table _runtime_preserve_seo_strategy_versions as select * from seo_strategy_versions;

create table _runtime_preserve_seo_research_sources as select * from seo_research_sources;

create table _runtime_preserve_seo_strategy_documents as select * from seo_strategy_documents;

create table _runtime_preserve_seo_topic_territories as select * from seo_topic_territories;

create table _runtime_preserve_topic_decision_results as select * from topic_decision_results;

create table _runtime_preserve_content_production_groups as select * from content_production_groups;

create table _runtime_preserve_seo_keyword_clusters as select * from seo_keyword_clusters;

create table _runtime_preserve_topic_decision_items as select * from topic_decision_items;

create table _runtime_preserve_content_artifacts as select * from content_artifacts;

create table _runtime_preserve_content_review_interactions as select * from content_review_interactions;

create table _runtime_preserve_seo_strategy_keywords as select * from seo_strategy_keywords;

create table _runtime_preserve_seo_keyword_sources as select * from seo_keyword_sources;

drop table seo_keyword_sources;

drop table seo_strategy_keywords;

drop table content_review_interactions;

drop table content_artifacts;

drop table topic_decision_items;

drop table seo_keyword_clusters;

drop table content_production_groups;

drop table topic_decision_results;

drop table seo_topic_territories;

drop table seo_strategy_documents;

drop table seo_research_sources;

drop table seo_strategy_versions;

drop table agent_memories;

CREATE TABLE agent_memories (
  id text primary key,
  workspace_id text not null,
  site_id text not null references sites(id) on delete cascade,
  agent_id text not null,
  kind text not null,
  version integer not null,
  content_json text not null,
  evidence_refs_json text not null,
  source_run_id text not null,
  supersedes_memory_id text not null default '',
  created_at text not null,
  unique (workspace_id, site_id, agent_id, kind, version)
);

insert into agent_memories(id,workspace_id,site_id,agent_id,kind,version,content_json,evidence_refs_json,source_run_id,supersedes_memory_id,created_at) select id,workspace_id,site_id,agent_id,kind,version,content_json,evidence_refs_json,source_run_id,supersedes_memory_id,created_at from _runtime_preserve_agent_memories;

CREATE UNIQUE INDEX agent_memories_source_kind_idx
  on agent_memories (source_run_id, kind);

CREATE TABLE seo_strategy_versions (
  id text primary key,
  site_id text not null references sites(id) on delete cascade,
  run_id text not null,
  submission_operation_id text not null,
  version integer not null,
  status text not null default 'draft',
  change_summary text not null default '',
  business_snapshot_json text not null default '{}',
  research_scope_json text not null default '{}',
  source_locale text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), locale_version integer not null default 0,
  unique(site_id, version)
);

insert into seo_strategy_versions(id,site_id,run_id,version,status,change_summary,business_snapshot_json,research_scope_json,source_locale,created_at,locale_version,submission_operation_id) select id,site_id,run_id,version,status,change_summary,business_snapshot_json,research_scope_json,source_locale,created_at,locale_version, 'legacy:' || id from _runtime_preserve_seo_strategy_versions;

CREATE INDEX idx_seo_strategy_versions_site
  on seo_strategy_versions(site_id, version desc);

CREATE UNIQUE INDEX seo_strategy_versions_one_active_locale_idx
  on seo_strategy_versions (site_id, source_locale)
  where status = 'active';

CREATE UNIQUE INDEX seo_strategy_versions_locale_version_idx
  on seo_strategy_versions(site_id, source_locale, locale_version);

CREATE INDEX idx_seo_strategy_versions_site_locale
  on seo_strategy_versions(site_id, source_locale, locale_version desc);

create unique index seo_strategy_versions_submission_operation on seo_strategy_versions(submission_operation_id);

CREATE TABLE seo_research_sources (
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

insert into seo_research_sources(id,strategy_version_id,source_type,url,title,query,locale,market,status,observation_md,metadata_json,observed_at) select id,strategy_version_id,source_type,url,title,query,locale,market,status,observation_md,metadata_json,observed_at from _runtime_preserve_seo_research_sources;

CREATE INDEX idx_seo_research_sources_version
  on seo_research_sources(strategy_version_id, source_type);

CREATE TABLE seo_strategy_documents (
  id text primary key,
  strategy_version_id text not null references seo_strategy_versions(id) on delete cascade,
  doc_type text not null,
  body_md text not null default '',
  content_hash text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique(strategy_version_id, doc_type)
);

insert into seo_strategy_documents(id,strategy_version_id,doc_type,body_md,content_hash,created_at) select id,strategy_version_id,doc_type,body_md,content_hash,created_at from _runtime_preserve_seo_strategy_documents;

CREATE INDEX idx_seo_strategy_documents_version
  on seo_strategy_documents(strategy_version_id, doc_type);

CREATE TABLE seo_topic_territories (
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

insert into seo_topic_territories(id,strategy_version_id,territory_key,name,priority_band,status,audience_summary,search_job_summary,business_goal,conversion_goal,summary,sort_order) select id,strategy_version_id,territory_key,name,priority_band,status,audience_summary,search_job_summary,business_goal,conversion_goal,summary,sort_order from _runtime_preserve_seo_topic_territories;

CREATE INDEX idx_seo_topic_territories_version
  on seo_topic_territories(strategy_version_id, priority_band, sort_order);

CREATE TABLE topic_decision_results (
  id text primary key,
  workspace_id text not null,
  site_id text not null references sites(id) on delete cascade,
  run_id text not null,
  submission_operation_id text not null,
  strategy_version_id text not null references seo_strategy_versions(id),
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
, language_decisions_json text not null default '[]');

insert into topic_decision_results(id,workspace_id,site_id,run_id,strategy_version_id,strategy_version,decision_type,status,group_goal,rationale,group_hypothesis,expected_signals_json,risks_json,unknowns_json,previous_group_relationship,research_request_json,web_evidence_json,requested_count,locales_json,reviewed_by,review_note,reviewed_at,created_at,updated_at,language_decisions_json,submission_operation_id) select id,workspace_id,site_id,run_id,strategy_version_id,strategy_version,decision_type,status,group_goal,rationale,group_hypothesis,expected_signals_json,risks_json,unknowns_json,previous_group_relationship,research_request_json,web_evidence_json,requested_count,locales_json,reviewed_by,review_note,reviewed_at,created_at,updated_at,language_decisions_json, 'legacy:' || id from _runtime_preserve_topic_decision_results;

CREATE UNIQUE INDEX topic_decision_one_pending_group_idx
  on topic_decision_results (workspace_id, site_id)
  where status = 'draft';

CREATE INDEX topic_decision_results_history_idx
  on topic_decision_results (workspace_id, site_id, created_at desc);

create unique index topic_decision_results_submission_operation on topic_decision_results(submission_operation_id);

CREATE TABLE content_production_groups (
  id text primary key,
  workspace_id text not null,
  site_id text not null,
  decision_group_id text not null unique,
  parent_run_id text not null default '',
  status text not null default 'queued'
    check (status in ('queued', 'producing', 'reviewing', 'needs_attention', 'awaiting_review')),
  total_items integer not null default 0,
  ready_items integer not null default 0,
  failed_items integer not null default 0,
  review_round integer not null default 0,
  review_json text not null default '{}',
  error text not null default '',
  created_at text not null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces(id),
  foreign key (site_id) references sites(id),
  foreign key (decision_group_id) references topic_decision_results(id)
);

insert into content_production_groups(id,workspace_id,site_id,decision_group_id,parent_run_id,status,total_items,ready_items,failed_items,review_round,review_json,error,created_at,updated_at) select id,workspace_id,site_id,decision_group_id,parent_run_id,status,total_items,ready_items,failed_items,review_round,review_json,error,created_at,updated_at from _runtime_preserve_content_production_groups;

CREATE INDEX content_production_groups_site_idx
  on content_production_groups(workspace_id, site_id, created_at desc);

CREATE TABLE seo_keyword_clusters (
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

insert into seo_keyword_clusters(id,strategy_version_id,territory_id,cluster_key,name,priority_band,status,strategic_role,recommended_hub,conversion_goal,summary,sort_order) select id,strategy_version_id,territory_id,cluster_key,name,priority_band,status,strategic_role,recommended_hub,conversion_goal,summary,sort_order from _runtime_preserve_seo_keyword_clusters;

CREATE INDEX idx_seo_keyword_clusters_version
  on seo_keyword_clusters(strategy_version_id, territory_id, sort_order);

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
  market text not null default '',
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
  unique (result_id, sort_order),
  unique (result_id, strategy_keyword_id)
);

insert into topic_decision_items(id,result_id,strategy_keyword_id,keyword_id,topic_key,title_direction,primary_keyword,content_type,locale,market,search_intent,group_role,rationale,hypothesis,evidence_json,relationship_to_existing,risk,sort_order,topic_id,job_id,created_at,strategy_version_id,strategy_version) select id,result_id,strategy_keyword_id,keyword_id,topic_key,title_direction,primary_keyword,content_type,locale,market,search_intent,group_role,rationale,hypothesis,evidence_json,relationship_to_existing,risk,sort_order,topic_id,job_id,created_at,strategy_version_id,strategy_version from _runtime_preserve_topic_decision_items;

CREATE INDEX topic_decision_items_result_idx
  on topic_decision_items (result_id, sort_order);

CREATE INDEX topic_decision_items_strategy_idx
  on topic_decision_items(strategy_version_id, locale);

CREATE TABLE content_artifacts (
  id text primary key,
  group_id text not null,
  job_id text not null,
  decision_item_id text not null,
  child_run_id text not null,
  submission_operation_id text not null,
  attempt integer not null,
  status text not null default 'candidate'
    check (status in ('candidate', 'accepted', 'rejected', 'failed')),
  versions_json text not null default '[]',
  seo_contract_json text not null default '{}',
  qa_report_json text not null default '{}',
  parent_review_json text not null default '{}',
  supersedes_artifact_id text not null default '',
  created_at text not null,
  updated_at text not null,
  foreign key (group_id) references content_production_groups(id),
  foreign key (job_id) references jobs(id),
  foreign key (decision_item_id) references topic_decision_items(id)
);

insert into content_artifacts(id,group_id,job_id,decision_item_id,child_run_id,attempt,status,versions_json,seo_contract_json,qa_report_json,parent_review_json,supersedes_artifact_id,created_at,updated_at,submission_operation_id) select id,group_id,job_id,decision_item_id,child_run_id,attempt,status,versions_json,seo_contract_json,qa_report_json,parent_review_json,supersedes_artifact_id,created_at,updated_at, 'legacy:' || id from _runtime_preserve_content_artifacts;

CREATE UNIQUE INDEX content_artifacts_job_attempt_idx
  on content_artifacts(job_id, attempt);

CREATE INDEX content_artifacts_group_idx
  on content_artifacts(group_id, created_at asc);

create unique index content_artifacts_submission_operation on content_artifacts(submission_operation_id);

CREATE TABLE content_review_interactions (
  id text primary key,
  idempotency_key text not null unique,
  group_id text not null,
  job_id text not null,
  artifact_id text not null default '',
  parent_run_id text not null default '',
  child_run_id text not null default '',
  kind text not null,
  actor_type text not null,
  actor_id text not null default '',
  summary text not null,
  payload_json text not null default '{}',
  created_at text not null,
  foreign key (group_id) references content_production_groups(id),
  foreign key (job_id) references jobs(id)
);

insert into content_review_interactions(id,idempotency_key,group_id,job_id,artifact_id,parent_run_id,child_run_id,kind,actor_type,actor_id,summary,payload_json,created_at) select id,idempotency_key,group_id,job_id,artifact_id,parent_run_id,child_run_id,kind,actor_type,actor_id,summary,payload_json,created_at from _runtime_preserve_content_review_interactions;

CREATE INDEX content_review_interactions_job_idx
  on content_review_interactions(job_id, created_at asc);

CREATE INDEX content_review_interactions_group_idx
  on content_review_interactions(group_id, created_at asc);

CREATE TABLE seo_strategy_keywords (
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

insert into seo_strategy_keywords(id,strategy_version_id,keyword_id,cluster_id,intent,journey_stage,serp_shape,recommended_page_type,business_relevance,conversion_route,priority_band,priority_rationale,coverage_status,decision,existing_url,evidence_summary,created_at) select id,strategy_version_id,keyword_id,cluster_id,intent,journey_stage,serp_shape,recommended_page_type,business_relevance,conversion_route,priority_band,priority_rationale,coverage_status,decision,existing_url,evidence_summary,created_at from _runtime_preserve_seo_strategy_keywords;

CREATE INDEX idx_seo_strategy_keywords_version
  on seo_strategy_keywords(strategy_version_id, cluster_id, priority_band, decision);

CREATE TABLE seo_keyword_sources (
  strategy_keyword_id text not null references seo_strategy_keywords(id) on delete cascade,
  source_id text not null references seo_research_sources(id) on delete cascade,
  evidence_type text not null default 'web',
  note text not null default '',
  primary key(strategy_keyword_id, source_id)
);

insert into seo_keyword_sources(strategy_keyword_id,source_id,evidence_type,note) select strategy_keyword_id,source_id,evidence_type,note from _runtime_preserve_seo_keyword_sources;

create table _runtime_migration_check(value integer not null check(value=1));

insert into _runtime_migration_check select CASE when (select count(*) from agent_memories)=(select count(*) from _runtime_preserve_agent_memories) then 1 else 0 END;

drop table _runtime_preserve_agent_memories;

insert into _runtime_migration_check select CASE when (select count(*) from seo_strategy_versions)=(select count(*) from _runtime_preserve_seo_strategy_versions) then 1 else 0 END;

drop table _runtime_preserve_seo_strategy_versions;

insert into _runtime_migration_check select CASE when (select count(*) from seo_research_sources)=(select count(*) from _runtime_preserve_seo_research_sources) then 1 else 0 END;

drop table _runtime_preserve_seo_research_sources;

insert into _runtime_migration_check select CASE when (select count(*) from seo_strategy_documents)=(select count(*) from _runtime_preserve_seo_strategy_documents) then 1 else 0 END;

drop table _runtime_preserve_seo_strategy_documents;

insert into _runtime_migration_check select CASE when (select count(*) from seo_topic_territories)=(select count(*) from _runtime_preserve_seo_topic_territories) then 1 else 0 END;

drop table _runtime_preserve_seo_topic_territories;

insert into _runtime_migration_check select CASE when (select count(*) from topic_decision_results)=(select count(*) from _runtime_preserve_topic_decision_results) then 1 else 0 END;

drop table _runtime_preserve_topic_decision_results;

insert into _runtime_migration_check select CASE when (select count(*) from content_production_groups)=(select count(*) from _runtime_preserve_content_production_groups) then 1 else 0 END;

drop table _runtime_preserve_content_production_groups;

insert into _runtime_migration_check select CASE when (select count(*) from seo_keyword_clusters)=(select count(*) from _runtime_preserve_seo_keyword_clusters) then 1 else 0 END;

drop table _runtime_preserve_seo_keyword_clusters;

insert into _runtime_migration_check select CASE when (select count(*) from topic_decision_items)=(select count(*) from _runtime_preserve_topic_decision_items) then 1 else 0 END;

drop table _runtime_preserve_topic_decision_items;

insert into _runtime_migration_check select CASE when (select count(*) from content_artifacts)=(select count(*) from _runtime_preserve_content_artifacts) then 1 else 0 END;

drop table _runtime_preserve_content_artifacts;

insert into _runtime_migration_check select CASE when (select count(*) from content_review_interactions)=(select count(*) from _runtime_preserve_content_review_interactions) then 1 else 0 END;

drop table _runtime_preserve_content_review_interactions;

insert into _runtime_migration_check select CASE when (select count(*) from seo_strategy_keywords)=(select count(*) from _runtime_preserve_seo_strategy_keywords) then 1 else 0 END;

drop table _runtime_preserve_seo_strategy_keywords;

insert into _runtime_migration_check select CASE when (select count(*) from seo_keyword_sources)=(select count(*) from _runtime_preserve_seo_keyword_sources) then 1 else 0 END;

drop table _runtime_preserve_seo_keyword_sources;

drop table _runtime_migration_check;

pragma defer_foreign_keys=off;
