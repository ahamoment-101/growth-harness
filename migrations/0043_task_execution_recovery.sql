alter table agent_runs add column execution_outcome text not null default '';
alter table agent_runs add column execution_failure_json text not null default '{}';
alter table agent_tasks add column recovery_policy_version integer not null default 0;
create table agent_task_recoveries (
  task_id text not null references agent_tasks(id) on delete cascade,
  epoch integer not null,
  predecessor_run_id text not null,
  successor_run_id text not null unique,
  status text not null check(status in ('pending','dispatching','dispatched','blocked','cancelled')),
  attempt integer not null,
  stall_count integer not null,
  progress_turn integer not null,
  next_attempt_at text not null,
  failure_json text not null,
  reason text not null default '',
  updated_at text not null,
  primary key(task_id,epoch)
);
create index agent_task_recoveries_due on agent_task_recoveries(status,next_attempt_at);
alter table agent_task_model_reservations add column operation_id text not null default '';
create index agent_task_model_operation on agent_task_model_reservations(task_id,operation_id,status);
create table agent_request_samples (
  run_id text not null references agent_runs(id) on delete cascade,
  step_key text not null,
  fetch_calls integer not null,
  d1_calls integer not null,
  r2_calls integer not null,
  recorded_at text not null,
  primary key(run_id,step_key)
);
