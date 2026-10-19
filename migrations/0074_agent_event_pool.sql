-- One durable pool of actionable facts. Subscriptions route delivery; they grant no tool authority.
alter table jobs add column publication_operation_id text not null default '';
create table agent_event_types (
  type text primary key,
  schema_version integer not null,
  description text not null
);
create table agent_event_subscriptions (
  agent_id text not null,
  type text not null references agent_event_types(type),
  enabled integer not null default 1 check(enabled in (0,1)),
  primary key(agent_id,type)
);
create index agent_event_subscriptions_type on agent_event_subscriptions(type,enabled,agent_id);
insert into agent_event_types values
  ('content.article_ready_for_publication_review',1,'An accepted article version needs a publication decision'),
  ('agent.task_report_ready',1,'A specialist checkpoint needs its parent Agent judgment');
insert into agent_event_subscriptions(agent_id,type) values
  ('growth_leader','content.article_ready_for_publication_review'),
  ('growth_leader','agent.task_report_ready');

create table agent_pool_events (
  id text primary key,
  workspace_id text not null,
  site_id text not null,
  type text not null references agent_event_types(type),
  schema_version integer not null,
  subject_id text not null,
  subject_version text not null,
  source_ref text not null default '',
  summary text not null default '',
  available_at text not null,
  created_at text not null
);
create table agent_event_deliveries (
  event_id text not null references agent_pool_events(id),
  agent_id text not null,
  workspace_id text not null,
  site_id text not null,
  available_at text not null,
  status text not null default 'pending' check(status in ('pending','delivered','waiting','completed','superseded')),
  target_run_id text not null default '',
  delivered_at text not null default '',
  resolved_at text not null default '',
  result_ref text not null default '',
  decision text not null default '',
  operation_id text not null default '',
  primary key(event_id,agent_id)
);
create index agent_event_deliveries_due on agent_event_deliveries(status,available_at,event_id,agent_id);
create index agent_event_deliveries_recipient on agent_event_deliveries(workspace_id,site_id,agent_id,status,available_at,event_id);
create index agent_event_deliveries_run on agent_event_deliveries(target_run_id,status,available_at,event_id);

-- The accepted version and its delivery are committed with the job transition.
create trigger article_review_event after update of status,current_artifact_id on jobs
when new.status='awaiting_review' and new.current_artifact_id!=''
  and (old.status is not new.status or old.current_artifact_id is not new.current_artifact_id)
BEGIN
  insert or ignore into agent_pool_events(id,workspace_id,site_id,type,schema_version,subject_id,subject_version,source_ref,summary,available_at,created_at)
    select 'article-review:'||new.id||':'||new.current_artifact_id,s.workspace_id,new.site_id,
      'content.article_ready_for_publication_review',1,new.id,new.current_artifact_id,new.production_group_id,
      coalesce(new.en_title,''),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      from sites s where s.id=new.site_id;
  insert or ignore into agent_event_deliveries(event_id,agent_id,workspace_id,site_id,available_at)
    select 'article-review:'||new.id||':'||new.current_artifact_id,sub.agent_id,s.workspace_id,new.site_id,
      strftime('%Y-%m-%dT%H:%M:%fZ','now') from sites s join agent_event_subscriptions sub
      on sub.type='content.article_ready_for_publication_review' and sub.enabled=1 where s.id=new.site_id;
  update agent_event_deliveries set status='superseded',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    where event_id='article-review:'||old.id||':'||old.current_artifact_id and old.current_artifact_id!=new.current_artifact_id
      and operation_id='' and status in ('pending','delivered','waiting');
END;
create trigger article_review_event_closed after update of status on jobs
when old.status='awaiting_review' and new.status!='awaiting_review'
BEGIN
  update agent_event_deliveries set status='superseded',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    where event_id='article-review:'||old.id||':'||old.current_artifact_id
      and operation_id='' and status in ('pending','delivered','waiting');
END;

-- Parent-directed reports share the pool. Older Leader Runs retain their pinned legacy inbox.
create trigger agent_task_report_event after update of status on agent_tasks
when new.parent_task_id!='' and new.status!='running' and old.status is not new.status
BEGIN
  insert or ignore into agent_pool_events(id,workspace_id,site_id,type,schema_version,subject_id,subject_version,source_ref,summary,available_at,created_at)
    select 'task-report:'||new.id||':'||new.execution_id||':'||new.status||':'||new.assignment_id,
      new.workspace_id,new.site_id,'agent.task_report_ready',1,new.id,
      new.execution_id||':'||new.status||':'||new.assignment_id,p.active_run_id,
      new.agent_id||' '||new.status,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      from agent_tasks p join agent_event_subscriptions sub on sub.agent_id=p.agent_id
        and sub.type='agent.task_report_ready' and sub.enabled=1
      where p.id=new.parent_task_id and (p.agent_id!='growth_leader' or p.definition_version>=3);
  insert or ignore into agent_event_deliveries(event_id,agent_id,workspace_id,site_id,available_at,target_run_id)
    select 'task-report:'||new.id||':'||new.execution_id||':'||new.status||':'||new.assignment_id,
      p.agent_id,new.workspace_id,new.site_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),p.active_run_id
      from agent_tasks p join agent_event_subscriptions sub on sub.agent_id=p.agent_id
        and sub.type='agent.task_report_ready' and sub.enabled=1
      where p.id=new.parent_task_id and (p.agent_id!='growth_leader' or p.definition_version>=3);
END;

-- Existing accepted articles must enter the same pool exactly once.
insert or ignore into agent_pool_events(id,workspace_id,site_id,type,schema_version,subject_id,subject_version,source_ref,summary,available_at,created_at)
  select 'article-review:'||j.id||':'||j.current_artifact_id,s.workspace_id,j.site_id,
    'content.article_ready_for_publication_review',1,j.id,j.current_artifact_id,j.production_group_id,
    coalesce(j.en_title,''),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    from jobs j join sites s on s.id=j.site_id where j.status='awaiting_review' and j.current_artifact_id!='';
insert or ignore into agent_event_deliveries(event_id,agent_id,workspace_id,site_id,available_at)
  select e.id,sub.agent_id,e.workspace_id,e.site_id,e.available_at from agent_pool_events e
  join agent_event_subscriptions sub on sub.type=e.type and sub.enabled=1
  where e.type='content.article_ready_for_publication_review';

-- Recording a pool observation marks delivery; a model reply alone never resolves it.
create trigger agent_event_delivery_read after insert on agent_conversation_messages
when substr(new.message_key,1,6)='event:'
BEGIN
  update agent_event_deliveries set status='delivered',target_run_id=(select active_run_id from agent_tasks where id=new.task_id),
    delivered_at=new.created_at,available_at=date('now','+1 day')||'T00:00:00.000Z'
    where event_id=substr(new.message_key,7) and agent_id=(select agent_id from agent_tasks where id=new.task_id) and status='pending';
END;
create trigger agent_event_delivery_reminder after insert on agent_conversation_messages
when substr(new.message_key,1,15)='event-followup:'
BEGIN
  update agent_event_deliveries set available_at=date('now','+1 day')||'T00:00:00.000Z'
    where event_id=substr(new.message_key,16,length(new.message_key)-26)
      and agent_id=(select agent_id from agent_tasks where id=new.task_id) and status='delivered';
END;
