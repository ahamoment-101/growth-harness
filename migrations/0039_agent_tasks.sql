-- Task lifetime is independent of Workflow/Run lifetime. No legacy data is deleted.
create table agent_tasks (
  id text primary key,
  workspace_id text not null,
  site_id text not null,
  agent_id text not null,
  agent_instance_id text not null,
  definition_version integer not null,
  status text not null check(status in ('running','waiting','paused','completed','failed','cancelled')),
  reason text not null default '',
  outcome text not null default '',
  active_run_id text not null,
  epoch integer not null default 1,
  revision integer not null default 0,
  next_turn integer not null default 1,
  goal_json text not null,
  workspace_json text not null default '{}',
  output_json text not null default '{}',
  max_turns integer not null,
  max_model_calls integer not null,
  max_tokens integer not null,
  reserved_tokens integer not null default 0,
  model_calls integer not null default 0,
  last_operation_id text not null default '',
  created_at text not null,
  updated_at text not null
);
create unique index agent_tasks_one_open on agent_tasks(workspace_id,site_id,agent_id,agent_instance_id)
  where status in ('running','waiting','paused');
create table agent_task_runs (
  run_id text primary key,
  task_id text not null references agent_tasks(id),
  epoch integer not null
);
create index agent_task_runs_task on agent_task_runs(task_id);
create table agent_task_operations (
  id text primary key,
  task_id text not null references agent_tasks(id),
  turn integer not null,
  status text not null check(status in ('deciding','ready','running','succeeded','failed','unknown')),
  context_json text not null,
  action_json text not null default '{}',
  output_json text not null default '{}',
  external_json text not null default '{}',
  error text not null default '',
  created_at text not null,
  updated_at text not null,
  unique(task_id,turn)
);
create table agent_task_model_reservations (
  id text primary key,
  task_id text not null references agent_tasks(id),
  tokens integer not null,
  status text not null default 'reserved' check(status in ('reserved','running','succeeded','failed')),
  response_json text not null default '',
  request_json text not null default '',
  created_at text not null
);
create table agent_task_inputs (
  id text primary key,
  task_id text not null references agent_tasks(id),
  actor_id text not null,
  content text not null,
  created_at text not null
);
