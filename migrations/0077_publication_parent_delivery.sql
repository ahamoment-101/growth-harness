-- Route article review back through the content task that produced it. Standalone
-- content work retains the site publication conversation as its fallback.
alter table sites add column publication_language_mode text not null default 'all_enabled'
  check(publication_language_mode in ('all_enabled','source_only'));
alter table jobs add column review_operation_id text not null default '';

-- A human may win after Leader claims a review event but before its effect.
-- Keep the Leader's own publication claim; close a claim displaced by another actor.
drop trigger article_review_event_closed;
create trigger article_review_event_closed after update of status on jobs
when old.status='awaiting_review' and new.status!='awaiting_review'
BEGIN
  update agent_event_deliveries set status='superseded',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    where event_id='article-review:'||old.id||':'||old.current_artifact_id
      and (operation_id=''
        or (new.status='publishing' and new.publication_operation_id!=operation_id)
        or (new.status='drafting' and new.review_operation_id!=operation_id)
        or new.status not in ('publishing','drafting'))
      and status in ('pending','delivered','waiting');
END;

create trigger article_review_parent_delivery after insert on agent_event_deliveries
when new.agent_id='growth_leader' and new.target_run_id=''
  and exists(select 1 from agent_pool_events e where e.id=new.event_id and e.type='content.article_ready_for_publication_review')
BEGIN
  update agent_event_deliveries set target_run_id=coalesce((
    select leader.active_run_id from agent_pool_events e
    join jobs j on j.id=e.subject_id and j.site_id=e.site_id
    join content_production_groups g on g.id=j.production_group_id and g.site_id=j.site_id
    join agent_tasks editor on editor.active_run_id=g.parent_run_id and editor.workspace_id=g.workspace_id and editor.site_id=g.site_id
    join agent_tasks leader on leader.id=editor.parent_task_id and leader.workspace_id=editor.workspace_id and leader.site_id=editor.site_id
    where e.id=new.event_id and editor.agent_id='content_production' and leader.agent_id='growth_leader'
      and leader.status not in ('completed','cancelled','failed')
    limit 1
  ),'') where event_id=new.event_id and agent_id=new.agent_id;
END;

-- Existing unread reviews can still return to their original active conversation.
update agent_event_deliveries set target_run_id=coalesce((
  select leader.active_run_id from agent_pool_events e
  join jobs j on j.id=e.subject_id and j.site_id=e.site_id
  join content_production_groups g on g.id=j.production_group_id and g.site_id=j.site_id
  join agent_tasks editor on editor.active_run_id=g.parent_run_id and editor.workspace_id=g.workspace_id and editor.site_id=g.site_id
  join agent_tasks leader on leader.id=editor.parent_task_id and leader.workspace_id=editor.workspace_id and leader.site_id=editor.site_id
  where e.id=agent_event_deliveries.event_id and editor.agent_id='content_production' and leader.agent_id='growth_leader'
    and leader.status not in ('completed','cancelled','failed') limit 1
),'') where agent_id='growth_leader' and target_run_id='' and status='pending'
  and exists(select 1 from agent_pool_events e where e.id=agent_event_deliveries.event_id and e.type='content.article_ready_for_publication_review');

insert into agent_event_types(type,schema_version,description) values
  ('content.article_published',1,'The article has actually gone live');
insert into agent_event_subscriptions(agent_id,type) values('growth_leader','content.article_published');

create trigger article_published_parent_delivery after update of status on jobs
when new.status='published' and old.status!='published'
BEGIN
  insert or ignore into agent_pool_events(id,workspace_id,site_id,type,schema_version,subject_id,subject_version,source_ref,summary,available_at,created_at)
    select 'article-published:'||new.id||':'||new.current_artifact_id,
      leader.workspace_id,new.site_id,'content.article_published',1,new.id,new.current_artifact_id,
      g.id,coalesce(new.en_title,''),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    from content_production_groups g
    join agent_tasks editor on editor.active_run_id=g.parent_run_id and editor.workspace_id=g.workspace_id and editor.site_id=g.site_id
    join agent_tasks leader on leader.id=editor.parent_task_id and leader.workspace_id=editor.workspace_id and leader.site_id=editor.site_id
    where g.id=new.production_group_id and g.site_id=new.site_id and editor.agent_id='content_production'
      and leader.agent_id='growth_leader' and leader.status not in ('completed','cancelled','failed');
  insert or ignore into agent_event_deliveries(event_id,agent_id,workspace_id,site_id,available_at,target_run_id)
    select 'article-published:'||new.id||':'||new.current_artifact_id,
      leader.agent_id,leader.workspace_id,new.site_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),leader.active_run_id
    from content_production_groups g
    join agent_tasks editor on editor.active_run_id=g.parent_run_id and editor.workspace_id=g.workspace_id and editor.site_id=g.site_id
    join agent_tasks leader on leader.id=editor.parent_task_id and leader.workspace_id=editor.workspace_id and leader.site_id=editor.site_id
    join agent_event_subscriptions sub on sub.agent_id=leader.agent_id and sub.type='content.article_published' and sub.enabled=1
    where g.id=new.production_group_id and g.site_id=new.site_id and editor.agent_id='content_production'
      and leader.agent_id='growth_leader' and leader.status not in ('completed','cancelled','failed');
END;
