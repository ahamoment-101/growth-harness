-- Public progress is committed with its source message, independently of compaction.
create table agent_work_notes (
  task_id text not null references agent_tasks(id) on delete cascade,
  sequence integer not null,
  body text not null,
  created_at text not null,
  primary key(task_id, sequence)
);
-- One claimed response per observed interaction; retries keep the same input and identity.
create table agent_work_responses (
  command_id text primary key,
  task_id text not null references agent_tasks(id) on delete cascade,
  request_id text not null,
  version text not null,
  actor_id text not null,
  input_json text not null,
  node_json text not null default '{}',
  receipt_json text not null default '',
  lease_id text not null default '',
  lease_until text not null default '',
  created_at text not null,
  unique(task_id, request_id, version)
);
alter table topic_decision_results add column review_operation_id text not null default '';
