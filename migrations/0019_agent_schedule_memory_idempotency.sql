-- Durable scheduler deduplication and Memory step replay idempotency.

alter table agent_runs add column schedule_key text not null default '';

create unique index if not exists agent_runs_schedule_key_idx
  on agent_runs (workspace_id, site_id, agent_id, schedule_key)
  where schedule_key <> '';

create unique index if not exists agent_memories_source_kind_idx
  on agent_memories (source_run_id, kind);
