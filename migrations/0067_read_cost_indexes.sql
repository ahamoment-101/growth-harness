-- Read-cost indexes. Every polled view and Run lookup must be an index seek, never a table scan.
-- Run-to-task lookups (taskForRun, Leader conversation reads, delivery recovery).
create index if not exists agent_tasks_active_run on agent_tasks(active_run_id);
-- Newest starts/finishes for the activity feed and cheap change markers for polled views.
create index if not exists agent_tasks_site_created on agent_tasks(workspace_id,site_id,created_at);
create index if not exists agent_tasks_site_updated on agent_tasks(workspace_id,site_id,updated_at);
create index if not exists agent_tasks_site_status_updated on agent_tasks(workspace_id,site_id,status,updated_at);
create index if not exists agent_task_checkpoints_created on agent_task_checkpoints(created_at);
create index if not exists jobs_site_updated on jobs(site_id,updated_at);
create index if not exists topic_decision_results_site_status on topic_decision_results(workspace_id,site_id,status,updated_at);
-- Responses still being verified; the change marker counts only these.
create index if not exists agent_work_responses_unfinished on agent_work_responses(command_id) where receipt_json='';
-- Minute-by-minute recovery scans: seek open work instead of walking finished history.
create index if not exists agent_tasks_execution on agent_tasks(execution_id);
create index if not exists agent_tasks_agent_status on agent_tasks(agent_id,status);
create index if not exists firecrawl_research_jobs_status on firecrawl_research_jobs(status,updated_at);
create index if not exists agent_runtime_executions_run on agent_runtime_executions(run_id);
create index if not exists leader_inputs_created on leader_inputs(created_at);
-- Per-task and per-run lookups on Agent execution paths.
create index if not exists agent_task_inputs_task on agent_task_inputs(task_id,created_at);
create index if not exists agent_runs_parent on agent_runs(parent_run_id);
create index if not exists keyword_library_entries_locale_count on keyword_library_entries(site_id,locale,kind,archived);
-- Hosted blogs resolve the site from the Host header on every public request.
create index if not exists sites_root_domain on sites(root_domain) where root_domain != '';
-- Bumped only by explicit "seen" acknowledgements, which change bubbles without touching tasks.
create table if not exists team_status_revisions (
  workspace_id text not null,
  site_id text not null,
  revision integer not null default 0,
  primary key (workspace_id,site_id)
);
