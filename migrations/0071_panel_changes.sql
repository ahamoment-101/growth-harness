-- Member panel live views (docs/real-time-updates-and-cache-architecture.md phase 2). Runtime progress is logged by the
-- Runtime itself (`task_progress`, throttled with its pokes); these cover writes made outside it.

-- A person's response to a pending request changes that task's interactions.
create trigger if not exists site_changes_work_response_insert after insert on agent_work_responses
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref)
    select t.workspace_id,t.site_id,'work_request',t.id from agent_tasks t where t.id=new.task_id;
END;
create trigger if not exists site_changes_work_response_receipt after update of receipt_json on agent_work_responses
when old.receipt_json is not new.receipt_json
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref)
    select t.workspace_id,t.site_id,'work_request',t.id from agent_tasks t where t.id=new.task_id;
END;

-- Execution state (recovering, waiting, handoff) is shown on the task detail.
create trigger if not exists site_changes_execution_state after update of status on agent_runtime_executions
when old.status is not new.status
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref)
    select t.workspace_id,t.site_id,'task_progress',t.id from agent_tasks t where t.id=new.task_id;
END;
