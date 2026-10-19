-- Opt-in stage policy is immutable for a Task. Historical tasks remain disabled.
alter table agent_tasks add column stage_policy_json text not null default '{}';
create table agent_execution_stages (
  task_id text not null references agent_tasks(id),
  number integer not null check(number > 0),
  initial_run_id text not null,
  active_run_id text not null,
  start_turn integer not null,
  end_turn integer,
  model_calls_start integer not null default 0,
  inference_units_start integer not null default 0,
  external_calls_start integer not null default 0,
  decision_turns_start integer not null default 0,
  closing_round integer not null default 0,
  status text not null default 'running',
  decision_json text not null default '{}',
  pending_json text not null default '[]',
  successor_run_id text not null default '',
  dispatch_error text not null default '',
  created_at text not null,
  finished_at text not null default '',
  primary key(task_id,number),
  unique(initial_run_id)
);
