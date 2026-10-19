-- A Run is a conversation; an Execution is a replaceable Workflow host.
-- Historical execution rows are not deleted by schema migrations.
alter table agent_tasks add column runtime_version integer not null default 1;
alter table agent_tasks add column assignment_id text not null default '';
create table agent_task_assignments (
  id text primary key,
  task_id text not null references agent_tasks(id),
  operation_id text not null unique,
  context_json text not null,
  created_at text not null
);
alter table agent_tasks add column pending_command_id text not null default '';
alter table agent_tasks add column execution_id text not null default '';
alter table agent_task_model_reservations add column outcome_state text not null default 'pending';
alter table agent_conversations add column normal_decisions integer not null default 0;
alter table agent_conversations add column tool_manifest_json text not null default '[]';
alter table agent_conversations add column definition_version integer not null default 0;
alter table agent_conversation_messages add column decision_kind text not null default 'normal';
create index agent_conversation_pending_calls on agent_conversation_calls(task_id,assistant_sequence) where result_sequence is null;
create table agent_runtime_executions (
  id text primary key,
  task_id text not null references agent_tasks(id),
  run_id text not null references agent_runs(id),
  epoch integer not null,
  workflow_id text not null unique,
  status text not null check(status in ('dispatching','running','waiting','recovering','finished','superseded','cancelled')),
  reason text not null default '',
  error_json text not null default '{}',
  durable_steps integer not null default 0,
  retry_at text not null default '',
  created_at text not null,
  updated_at text not null,
  unique(task_id,epoch)
);
create index agent_runtime_execution_recovery on agent_runtime_executions(status,retry_at);
create table agent_runtime_execution_steps (
  execution_id text not null references agent_runtime_executions(id),
  step_key text not null,
  primary key(execution_id,step_key)
);
create table agent_runtime_write_guards (
  task_id text not null,
  run_id text not null,
  execution_id text not null,
  epoch integer not null
);
-- This assertion executes in the SAME D1 transaction as the effect. It stores
-- no rows. In particular, a stale host cannot authorize itself by rereading epoch.
create trigger agent_runtime_write_fence before insert on agent_runtime_write_guards
BEGIN
  select raise(abort,'Runtime execution authority lost') where not exists (
    select 1 from agent_tasks t join agent_runtime_executions e on e.id=t.execution_id
    where t.id=new.task_id and t.active_run_id=new.run_id and t.epoch=new.epoch
      and e.id=new.execution_id and e.epoch=new.epoch and e.run_id=new.run_id
      and e.status='running' and t.status!='cancelled'
  );
  select raise(abort,'Runtime ancestor closed') where exists (
    with recursive ancestors(id,parent_task_id,status) as (
      select p.id,p.parent_task_id,p.status from agent_tasks t join agent_tasks p on p.id=t.parent_task_id where t.id=new.task_id
      union all select p.id,p.parent_task_id,p.status from agent_tasks p join ancestors a on p.id=a.parent_task_id
    ) select 1 from ancestors where status in ('completed','cancelled','failed')
  );
  select raise(ignore);
END;
create table agent_runtime_audits (
  task_id text not null references agent_tasks(id),
  number integer not null,
  start_decision integer not null,
  end_decision integer not null,
  status text not null check(status in ('normal','auditing','continued','finished')),
  operation_id text not null default '',
  decision_json text not null default '{}',
  created_at text not null,
  resolved_at text not null default '',
  primary key(task_id,number)
);
create table agent_conversation_compactions (
  task_id text not null references agent_tasks(id),
  version integer not null,
  through_sequence integer not null,
  summary_json text not null,
  request_id text not null,
  created_at text not null,
  primary key(task_id,version),
  unique(task_id,through_sequence)
);
create table agent_task_checkpoints (
  id text primary key,
  task_id text not null references agent_tasks(id),
  operation_id text not null unique,
  assignment_id text not null,
  output_json text not null,
  created_at text not null
);
create index agent_task_checkpoint_assignment on agent_task_checkpoints(task_id,assignment_id);
create table agent_topic_locale_decisions (
  task_id text not null references agent_tasks(id),
  locale text not null,
  operation_id text not null unique,
  context_ref text not null,
  output_json text not null,
  created_at text not null,
  primary key(task_id,locale)
);
create table agent_runtime_commands (
  command_id text primary key,
  task_id text not null references agent_tasks(id),
  command text not null,
  execution_id text not null default '',
  predecessor_json text not null default '{}',
  receipt_json text not null default '{}',
  created_at text not null
);

alter table firecrawl_research_jobs add column submission_execution_id text not null default '';

-- Large immutable Runtime content is chunked; D1 rows and Workflow receipts stay small.
create table agent_runtime_content_chunks (
  content_id text not null,
  chunk_index integer not null,
  character_offset integer not null,
  characters integer not null,
  value text not null,
  primary key(content_id,chunk_index)
);

create table agent_model_request_observations (
 request_id text primary key, task_id text not null, wire_json text not null,
 prefix_hash text not null, tool_hash text not null, compaction_version integer not null,
 cache_json text not null default '{"verification":"unavailable"}'
);
