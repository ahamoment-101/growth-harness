-- Stable task lineage survives execution retries. Existing tasks become roots.
alter table agent_tasks add column parent_task_id text not null default '';
alter table agent_tasks add column root_task_id text not null default '';
update agent_tasks set root_task_id = id;
create index agent_tasks_parent on agent_tasks(parent_task_id);
alter table agent_tasks add column external_calls integer not null default 0;
alter table agent_tasks add column max_external_calls integer not null default 80;
create table agent_task_external_usage (
  id text primary key,
  task_id text not null references agent_tasks(id),
  provider text not null,
  units integer not null,
  provider_credits real,
  browser_ms integer,
  created_at text not null
);
create table research_sources (
  id text primary key,
  task_id text not null references agent_tasks(id),
  workspace_id text not null,
  site_id text not null,
  url text not null,
  title text not null,
  captured_at text not null,
  object_key text not null,
  content_hash text not null,
  content_length integer not null,
  unique(task_id, object_key)
);
create index research_sources_task on research_sources(task_id);

alter table agent_task_model_reservations add column charged integer not null default 0;

alter table agent_tasks add column child_reserve_units integer not null default 0;
alter table agent_tasks add column child_reserve_calls integer not null default 0;
