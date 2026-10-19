-- Leader recovery runs every minute. It must read only what is still undelivered, never rescan history:
-- conversations stay open indefinitely and their inputs keep accumulating.

-- An input is read once the Leader's transcript records it (message key `leader-input:<id>`).
alter table leader_inputs add column read_at text;
update leader_inputs set read_at=created_at where exists(
  select 1 from agent_conversation_messages m join agent_tasks t on t.id=m.task_id
  where t.active_run_id=leader_inputs.conversation_id and m.message_key='leader-input:'||leader_inputs.id);
create index if not exists leader_inputs_unread on leader_inputs(conversation_id) where read_at is null;
create trigger if not exists leader_inputs_read after insert on agent_conversation_messages
when substr(new.message_key,1,13)='leader-input:'
BEGIN
  update leader_inputs set read_at=new.created_at where id=substr(new.message_key,14) and read_at is null;
END;

-- Delegated work whose latest non-running state is not yet reported to its Leader conversation.
-- A state change (re)queues the child; delivery removes exactly the queued version it handled.
create table if not exists leader_report_outbox (
  child_task_id text primary key,
  queued_at text not null
);
create trigger if not exists leader_report_outbox_state after update of status on agent_tasks
when new.status!='running' and old.status is not new.status and new.parent_task_id!=''
  and exists(select 1 from agent_tasks p where p.id=new.parent_task_id and p.agent_id='growth_leader')
BEGIN
  insert or replace into leader_report_outbox(child_task_id,queued_at) values(new.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
create trigger if not exists leader_report_outbox_insert after insert on agent_tasks
when new.status!='running' and new.parent_task_id!=''
  and exists(select 1 from agent_tasks p where p.id=new.parent_task_id and p.agent_id='growth_leader')
BEGIN
  insert or replace into leader_report_outbox(child_task_id,queued_at) values(new.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
-- Backfill once: children of open Leader conversations whose current state has no report yet.
insert or ignore into leader_report_outbox(child_task_id,queued_at)
  select c.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') from agent_tasks p join agent_tasks c on c.parent_task_id=p.id
  where p.agent_id='growth_leader' and p.status in ('running','waiting','paused') and c.status!='running'
    and not exists(select 1 from leader_inputs i where i.id='report:'||c.id||':'||c.execution_id||':'||c.status||':'||c.assignment_id);
