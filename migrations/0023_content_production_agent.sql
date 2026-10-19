alter table agent_runs add column agent_instance_id text not null default '';

drop index if exists agent_runs_one_active_idx;
create unique index if not exists agent_runs_one_active_instance_idx
  on agent_runs(workspace_id, site_id, agent_id, agent_instance_id)
  where status in ('queued', 'running', 'waiting_for_approval', 'waiting_for_input');

create table if not exists content_production_groups (
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

create index if not exists content_production_groups_site_idx
  on content_production_groups(workspace_id, site_id, created_at desc);

create table if not exists content_artifacts (
  id text primary key,
  group_id text not null,
  job_id text not null,
  decision_item_id text not null,
  child_run_id text not null unique,
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

create unique index if not exists content_artifacts_job_attempt_idx
  on content_artifacts(job_id, attempt);
create index if not exists content_artifacts_group_idx
  on content_artifacts(group_id, created_at asc);

alter table jobs add column production_group_id text not null default '';
alter table jobs add column current_artifact_id text not null default '';
alter table jobs add column child_run_id text not null default '';

create index if not exists jobs_production_group_idx on jobs(production_group_id, created_at asc);
