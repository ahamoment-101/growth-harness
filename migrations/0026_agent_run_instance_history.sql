-- Efficiently resolve the latest isolated child Run for one durable Agent instance.

create index if not exists agent_runs_instance_history_idx
  on agent_runs(workspace_id, site_id, agent_id, agent_instance_id, created_at desc);
