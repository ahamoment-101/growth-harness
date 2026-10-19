-- Agent Runtime v2 keeps logical decisions separate from physical provider attempts
-- and externalizes large action payloads. The migration is additive so an older
-- Worker can still read and replay agent_model_calls during rollback.

create table if not exists agent_model_attempts (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  purpose text not null default 'decision',
  decision_turn integer not null,
  attempt integer not null,
  provider text not null,
  model text not null,
  actual_provider text not null default '',
  status text not null check (status in ('running', 'succeeded', 'failed')),
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  text_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cost_usd real not null default 0,
  duration_ms integer not null default 0,
  request_id text not null default '',
  finish_reason text not null default '',
  error_kind text not null default '',
  error text not null default '',
  created_at text not null,
  finished_at text not null default '',
  unique (run_id, purpose, decision_turn, attempt)
);

create index if not exists idx_agent_model_attempts_run
  on agent_model_attempts(run_id, decision_turn, attempt);

create table if not exists agent_model_capabilities (
  model text primary key,
  provider text not null default 'openrouter',
  capability_json text not null,
  fetched_at text not null,
  expires_at text not null
);

create table if not exists agent_action_payloads (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  workspace_id text not null,
  site_id text not null,
  decision_turn integer not null,
  tool_name text not null,
  direction text not null check (direction in ('input', 'output')),
  status text not null default 'working',
  payload_json text not null,
  sha256 text not null,
  byte_length integer not null,
  created_at text not null,
  updated_at text not null,
  unique (run_id, decision_turn, tool_name, direction)
);

create index if not exists idx_agent_action_payloads_run
  on agent_action_payloads(run_id, decision_turn, tool_name);
