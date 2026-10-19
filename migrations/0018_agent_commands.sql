-- Idempotent, auditable human and chat control commands for Agent Runs.

create table if not exists agent_commands (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  command text not null check (command in ('cancel', 'retry', 'approve', 'reject', 'provide_input')),
  actor_id text not null,
  source text not null check (source in ('ui', 'chat', 'api')),
  status text not null check (status in ('processing', 'succeeded', 'failed')),
  payload_json text not null default '{}',
  result_json text not null default '{}',
  error text not null default '',
  created_at text not null,
  finished_at text not null default ''
);

create index if not exists agent_commands_run_created_idx
  on agent_commands (run_id, created_at desc);
