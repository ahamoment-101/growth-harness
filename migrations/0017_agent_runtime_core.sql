-- Shared Agent Runtime run, trace, context, tool, model, approval and memory truth.

create table if not exists agent_runs (
  id text primary key,
  workspace_id text not null,
  site_id text not null references sites(id) on delete cascade,
  agent_id text not null,
  definition_version integer not null,
  prompt_version text not null,
  trigger text not null,
  status text not null check (status in (
    'queued', 'running', 'waiting_for_approval', 'waiting_for_input',
    'succeeded', 'failed', 'cancelled'
  )),
  phase text not null,
  workflow_id text not null default '',
  root_run_id text not null,
  parent_run_id text not null default '',
  retry_of_run_id text not null default '',
  context_snapshot_id text not null default '',
  event_seq integer not null default 0,
  summary_json text not null default '{}',
  output_json text not null default '{}',
  error_code text not null default '',
  error text not null default '',
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd real not null default 0,
  started_at text not null default '',
  finished_at text not null default '',
  created_at text not null,
  updated_at text not null
);

create unique index if not exists agent_runs_one_active_idx
  on agent_runs (workspace_id, site_id, agent_id)
  where status in ('queued', 'running', 'waiting_for_approval', 'waiting_for_input');

create index if not exists agent_runs_site_history_idx
  on agent_runs (workspace_id, site_id, agent_id, created_at desc);

create table if not exists agent_events (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  seq integer not null,
  event_key text not null,
  kind text not null,
  phase text not null,
  actor_type text not null,
  actor_id text not null default '',
  payload_json text not null default '{}',
  created_at text not null,
  unique (run_id, seq),
  unique (run_id, event_key)
);

create table if not exists agent_context_snapshots (
  id text primary key,
  run_id text not null unique references agent_runs(id) on delete cascade,
  definition_version integer not null,
  prompt_version text not null,
  manifest_hash text not null,
  manifest_json text not null,
  truncated integer not null default 0,
  created_at text not null
);

create table if not exists agent_tool_calls (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  tool_call_key text not null,
  tool_name text not null,
  tool_version integer not null,
  capability text not null,
  status text not null,
  input_json text not null default '{}',
  output_json text not null default '{}',
  error text not null default '',
  retryable integer not null default 0,
  duration_ms integer not null default 0,
  started_at text not null,
  finished_at text not null default '',
  unique (run_id, tool_call_key)
);

create table if not exists agent_model_calls (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  turn integer not null,
  provider text not null,
  model text not null,
  status text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd real not null default 0,
  duration_ms integer not null default 0,
  request_id text not null default '',
  error text not null default '',
  created_at text not null,
  unique (run_id, turn)
);

create table if not exists agent_approvals (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  tool_call_key text not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'expired')),
  requested_json text not null default '{}',
  decided_by text not null default '',
  decision_note text not null default '',
  requested_at text not null,
  decided_at text not null default '',
  unique (run_id, tool_call_key)
);

create table if not exists agent_memories (
  id text primary key,
  workspace_id text not null,
  site_id text not null references sites(id) on delete cascade,
  agent_id text not null,
  kind text not null,
  version integer not null,
  content_json text not null,
  evidence_refs_json text not null,
  source_run_id text not null references agent_runs(id) on delete cascade,
  supersedes_memory_id text not null default '',
  created_at text not null,
  unique (workspace_id, site_id, agent_id, kind, version)
);
