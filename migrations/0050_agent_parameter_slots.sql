-- Existing tasks retain their model-facing contract; only new tasks opt in.
alter table agent_tasks add column parameter_contract_version integer not null default 0;
create table agent_parameter_slots (
  task_id text not null references agent_tasks(id),
  ref text not null,
  kind text not null,
  value_json text not null,
  primary key(task_id, ref)
);
create table agent_operation_bindings (
  operation_id text primary key references agent_task_operations(id),
  task_id text not null references agent_tasks(id),
  input_json text not null,
  resolved_json text not null
);
