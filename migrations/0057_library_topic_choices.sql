-- Preserve all IDs and references; remove only one-keyword-per-group uniqueness.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE _library_preserve_topic_items AS SELECT * FROM topic_decision_items;
DROP TABLE topic_decision_items;
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
  library_keyword_id text references keyword_library_entries(id),
  unique (result_id, sort_order)
);
INSERT INTO topic_decision_items(id,result_id,strategy_keyword_id,keyword_id,topic_key,title_direction,primary_keyword,content_type,locale,market,search_intent,group_role,rationale,hypothesis,evidence_json,relationship_to_existing,risk,sort_order,topic_id,job_id,created_at,strategy_version_id,strategy_version) SELECT id,result_id,strategy_keyword_id,keyword_id,topic_key,title_direction,primary_keyword,content_type,locale,market,search_intent,group_role,rationale,hypothesis,evidence_json,relationship_to_existing,risk,sort_order,topic_id,job_id,created_at,strategy_version_id,strategy_version FROM _library_preserve_topic_items;
DROP TABLE _library_preserve_topic_items;
CREATE INDEX topic_decision_items_result_idx ON topic_decision_items(result_id,sort_order);
CREATE INDEX topic_decision_items_strategy_idx ON topic_decision_items(strategy_version_id,locale);
