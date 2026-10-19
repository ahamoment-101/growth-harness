-- Per-site change log for live views (docs/real-time-updates-and-cache-architecture.md §5). Triggers record which row
-- changed in the same transaction as the business write, so no writer can forget to notify.
-- Rows carry references only, never business content.
create table if not exists site_changes (
  seq integer primary key autoincrement,
  workspace_id text not null,
  site_id text not null,
  kind text not null,
  ref text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists site_changes_site on site_changes(site_id,seq);

-- The minute-by-minute backstop pokes every site that changed after this watermark.
create table if not exists site_change_cursor (
  name text primary key,
  seq integer not null
);

-- Tasks: creation and visible state. Per-turn updated_at bumps do not log.
create trigger if not exists site_changes_task_insert after insert on agent_tasks
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref) values(new.workspace_id,new.site_id,'task',new.id);
END;
create trigger if not exists site_changes_task_state after update of status,outcome,reason on agent_tasks
when old.status is not new.status or old.outcome is not new.outcome or old.reason is not new.reason
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref) values(new.workspace_id,new.site_id,'task',new.id);
END;

-- Leader transcript rows (only the Leader's conversations are shown live).
create trigger if not exists site_changes_leader_message after insert on agent_conversation_messages
when exists(select 1 from agent_tasks t where t.id=new.task_id and t.agent_id='growth_leader')
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref)
    select t.workspace_id,t.site_id,'leader_message',t.active_run_id from agent_tasks t where t.id=new.task_id;
END;
create trigger if not exists site_changes_leader_input after insert on leader_inputs
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref)
    select c.workspace_id,c.site_id,'leader_input',c.id from leader_conversations c where c.id=new.conversation_id;
END;
create trigger if not exists site_changes_leader_conversation after insert on leader_conversations
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref) values(new.workspace_id,new.site_id,'leader_conversation',new.id);
END;

-- Requests waiting for a person.
create trigger if not exists site_changes_work_request_insert after insert on agent_work_requests
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref)
    select t.workspace_id,t.site_id,'work_request',t.id from agent_tasks t where t.id=new.task_id;
END;
create trigger if not exists site_changes_work_request_state after update of state on agent_work_requests
when old.state is not new.state
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref)
    select t.workspace_id,t.site_id,'work_request',t.id from agent_tasks t where t.id=new.task_id;
END;

-- Business queues shown as bubbles.
create trigger if not exists site_changes_job_insert after insert on jobs
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref)
    select s.workspace_id,s.id,'job',new.id from sites s where s.id=new.site_id;
END;
create trigger if not exists site_changes_job_status after update of status on jobs
when old.status is not new.status
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref)
    select s.workspace_id,s.id,'job',new.id from sites s where s.id=new.site_id;
END;
create trigger if not exists site_changes_topic_result_insert after insert on topic_decision_results
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref) values(new.workspace_id,new.site_id,'topic_result',new.id);
END;
create trigger if not exists site_changes_topic_result_status after update of status on topic_decision_results
when old.status is not new.status
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref) values(new.workspace_id,new.site_id,'topic_result',new.id);
END;

-- Read receipts clear completion bubbles; checkpoints are delivery milestones in the activity feed.
create trigger if not exists site_changes_receipt after insert on team_status_receipts
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref) values(new.workspace_id,new.site_id,'receipt',new.task_id);
END;
create trigger if not exists site_changes_checkpoint after insert on agent_task_checkpoints
BEGIN
  insert into site_changes(workspace_id,site_id,kind,ref)
    select t.workspace_id,t.site_id,'checkpoint',t.id from agent_tasks t where t.id=new.task_id;
END;
