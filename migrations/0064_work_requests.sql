-- Durable human requests for new interaction types. Existing domain queues retain
-- their source-of-truth adapters during adoption.
create table agent_work_requests (
  task_id text not null references agent_tasks(id) on delete cascade,
  request_id text not null,
  handler_id text not null,
  version text not null,
  state text not null check(state in ('pending','resolved')),
  node_json text not null,
  created_at text not null,
  updated_at text not null,
  primary key(task_id,request_id)
);
create index agent_work_requests_pending on agent_work_requests(state,task_id);
