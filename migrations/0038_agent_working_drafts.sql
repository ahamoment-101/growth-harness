-- One evolving artifact per Agent lineage.
--
-- Separate from agent_action_payloads on purpose. That table stores the payload
-- of one tool call at one turn and cascades away with its Run, which is correct
-- for per-call payloads and compaction snapshots. A working draft outlives any
-- single Run: a continuation chain hands it forward, and deleting the first Run
-- of a chain must not delete the work. Hence no run foreign key here — the Run
-- that last wrote is recorded for audit only.
create table if not exists agent_working_drafts (
  id text primary key,
  workspace_id text not null,
  site_id text not null,
  agent_id text not null,
  agent_instance_id text not null default '',
  lineage_id text not null,
  version integer not null default 0,
  status text not null default 'drafting' check (status in ('drafting', 'submitted', 'abandoned')),
  content_json text not null,
  byte_length integer not null default 0,
  -- Guards replay: a durable step that ran but never recorded its result runs
  -- again, and without this the second run appends a duplicate version.
  last_write_key text not null default '',
  last_run_id text not null default '',
  created_at text not null,
  updated_at text not null,
  unique (workspace_id, site_id, agent_id, agent_instance_id, lineage_id)
);

create index if not exists idx_agent_working_drafts_site
  on agent_working_drafts(workspace_id, site_id, agent_id, updated_at);
