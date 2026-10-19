-- Formal topic-decision business truth. Runtime state remains in agent_runs;
-- these tables preserve immutable group decisions and their downstream trace.

create table if not exists topic_decision_results (
  id text primary key,
  workspace_id text not null,
  site_id text not null references sites(id) on delete cascade,
  run_id text not null unique references agent_runs(id) on delete cascade,
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
);

create unique index if not exists topic_decision_one_pending_group_idx
  on topic_decision_results (workspace_id, site_id)
  where status = 'draft';

create index if not exists topic_decision_results_history_idx
  on topic_decision_results (workspace_id, site_id, created_at desc);

create table if not exists topic_decision_items (
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
  created_at text not null,
  unique (result_id, sort_order),
  unique (result_id, strategy_keyword_id)
);

create index if not exists topic_decision_items_result_idx
  on topic_decision_items (result_id, sort_order);

alter table topics add column decision_group_id text;
alter table topics add column decision_item_id text;
alter table topics add column plan_json text not null default '{}';

alter table jobs add column decision_group_id text;
alter table jobs add column decision_item_id text;
alter table jobs add column plan_json text not null default '{}';
