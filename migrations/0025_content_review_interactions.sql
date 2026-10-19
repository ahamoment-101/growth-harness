create table if not exists content_review_interactions (
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

create index if not exists content_review_interactions_job_idx
  on content_review_interactions(job_id, created_at asc);

create index if not exists content_review_interactions_group_idx
  on content_review_interactions(group_id, created_at asc);
