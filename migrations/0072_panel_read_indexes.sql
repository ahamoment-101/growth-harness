-- Member panels are rebuilt while an Agent works (at most every 5 s per watched topic). Each read must
-- touch the rows it shows, not the site's or the task's whole history.

-- Unfinished tasks of one Agent (list "current" section, runtime work requests).
create index if not exists agent_tasks_site_agent_status on agent_tasks(workspace_id,site_id,agent_id,status);
-- Newest page of a task's work stream, both sources ordered by time.
create index if not exists agent_work_notes_task_created on agent_work_notes(task_id,created_at);
create index if not exists agent_task_operations_task_created on agent_task_operations(task_id,created_at);
-- Records owned by one Run (0052 rebuilt these tables without them).
create index if not exists topic_decision_results_run on topic_decision_results(run_id);
create index if not exists content_artifacts_child_run on content_artifacts(child_run_id);
create index if not exists seo_strategy_versions_run on seo_strategy_versions(run_id);
