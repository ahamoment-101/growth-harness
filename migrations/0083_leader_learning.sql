-- Leader owns the learning interface; one Leader can coordinate several practices.
-- Preserve all existing records, revisions, receipts and evidence.
pragma defer_foreign_keys = on;
drop trigger learning_revision_guard;
drop trigger learning_revision_apply;
drop trigger learning_task_report;
drop trigger learning_article_published;
drop trigger learning_evidence_identity;
drop trigger learning_use_guard;
drop trigger learning_topic_review;
create table learning_records_next (
 id text primary key, workspace_id text not null, site_id text not null,
 origin_task_id text not null, version integer not null default 0,
 title text not null, status text not null default 'preparing', data_json text not null,
 created_at text not null, updated_at text not null
);
insert into learning_records_next select * from learning_records;
drop table learning_records;
alter table learning_records_next rename to learning_records;
create index learning_records_site on learning_records(workspace_id,site_id,updated_at desc,id desc);
create index learning_records_status on learning_records(workspace_id,site_id,status,updated_at desc,id desc);
create index learning_records_origin on learning_records(origin_task_id,id);
create trigger learning_revision_guard before insert on learning_revisions begin
 select case when not exists(select 1 from learning_records r join learning_operations o on o.id=new.operation_id
  where r.id=new.record_id and r.version=new.version-1 and r.workspace_id=o.workspace_id and r.site_id=o.site_id)
  then raise(abort,'Learning revision conflict') end;
end;
create trigger learning_revision_apply after insert on learning_revisions begin
 update learning_records set version=new.version,title=new.title,status=new.status,data_json=new.data_json,updated_at=new.created_at where id=new.record_id;
end;
create trigger learning_task_report after update of status on agent_tasks
when new.status!=old.status and new.status!='running' begin
 insert or ignore into learning_evidence(id,record_id,kind,source_ref,payload_json,created_at)
 select 'report:'||new.id||':'||new.execution_id||':'||new.status||':'||new.assignment_id,l.record_id,'report',new.id,
 json_object('agent_id',new.agent_id,'status',new.status,'reason',new.reason,'output',json(new.output_json)),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 from learning_tasks l where l.task_id=new.id;
 insert or ignore into learning_requests(id,record_id,phase,payload_json,available_at,created_at,updated_at,observation_bound)
 select e.id,e.record_id,'record',json_object('evidence_ref',e.id),e.created_at,e.created_at,e.created_at,1 from learning_evidence e
 where e.id='report:'||new.id||':'||new.execution_id||':'||new.status||':'||new.assignment_id;
end;
create trigger learning_article_published after update of status on jobs
when new.status='published' and old.status!='published' begin
 insert or ignore into learning_evidence(id,record_id,kind,source_ref,payload_json,created_at)
 select 'publication:'||new.id||':'||new.current_artifact_id,l.record_id,'publication',new.id,
 json_object('job_id',new.id,'artifact_id',new.current_artifact_id,'published_at',new.published_at,'versions',json(new.versions_json),'site_domain',s.domain,'locale_policy_json',json(case when json_valid(s.locale_policy_json) then s.locale_policy_json else '{}' end)),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 from content_production_groups g join agent_tasks t on t.active_run_id=g.parent_run_id join learning_tasks l on l.task_id=t.id
 join sites s on s.id=new.site_id where g.id=new.production_group_id;
 insert or ignore into learning_requests(id,record_id,phase,payload_json,available_at,created_at,updated_at,observation_bound)
 select e.id,e.record_id,'record',json_object('evidence_ref',e.id),e.created_at,e.created_at,e.created_at,0 from learning_evidence e
 where e.id='publication:'||new.id||':'||new.current_artifact_id;
end;
create trigger learning_evidence_identity before insert on learning_evidence begin
 select case when exists(select 1 from learning_evidence where id=new.id and (record_id!=new.record_id or payload_json!=new.payload_json))
 then raise(abort,'Learning evidence identity conflict') end;
end;
create trigger learning_use_guard before insert on learning_uses begin
 select case when not exists(select 1 from learning_records p join learning_records h on h.id=new.experience_id
   where p.id=new.practice_id and p.id!=h.id and p.workspace_id=h.workspace_id and p.site_id=h.site_id and h.version=new.observed_version
   and (exists(select 1 from learning_tasks t where t.task_id=new.task_id and t.record_id=p.id)
     or exists(select 1 from agent_tasks leader where leader.id=new.task_id and leader.id=p.origin_task_id
       and leader.agent_id='growth_leader' and leader.workspace_id=p.workspace_id and leader.site_id=p.site_id)))
 then raise(abort,'Learning adoption scope or version conflict') end;
end;
create trigger learning_topic_review after update of status on topic_decision_results
when new.status!=old.status and new.status in ('rejected','handed_off') begin
 insert or ignore into learning_evidence(id,record_id,kind,source_ref,payload_json,created_at)
 select 'topic-review:'||new.id||':'||new.status||':'||new.updated_at,l.record_id,'feedback',new.id,
 json_object('status',new.status,'review_note',new.review_note,'reviewed_by',new.reviewed_by,'reviewed_at',new.reviewed_at),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 from agent_tasks t join learning_tasks l on l.task_id=t.id where t.active_run_id=new.run_id;
 insert or ignore into learning_requests(id,record_id,phase,payload_json,available_at,created_at,updated_at,observation_bound)
 select e.id,e.record_id,'record',json_object('evidence_ref',e.id),e.created_at,e.created_at,e.created_at,1 from learning_evidence e
 where e.id='topic-review:'||new.id||':'||new.status||':'||new.updated_at;
end;

-- Saved before dispatch. The child can finish before the delegating tool returns.
create table learning_delegations (
 operation_id text primary key, leader_task_id text not null, record_id text not null references learning_records(id),
 child_run_id text not null unique, guidance_json text not null, created_at text not null
);
create index learning_delegations_record on learning_delegations(record_id,child_run_id);
create trigger learning_delegation_identity before insert on learning_delegations begin
 select case when exists(select 1 from learning_delegations where operation_id=new.operation_id
   and (leader_task_id!=new.leader_task_id or record_id!=new.record_id or child_run_id!=new.child_run_id))
 then raise(abort,'Learning delegation identity conflict') end;
end;
-- Attribution only: no specialist receives learning tools, prompts or judgments.
create trigger learning_inherit_task after insert on agent_tasks begin
 insert or ignore into learning_tasks(task_id,record_id,agent_id)
 select new.id,d.record_id,new.agent_id from learning_delegations d join learning_records r on r.id=d.record_id
 where d.child_run_id=new.active_run_id and d.leader_task_id=new.parent_task_id
   and r.workspace_id=new.workspace_id and r.site_id=new.site_id;
 insert or ignore into learning_tasks(task_id,record_id,agent_id)
 select new.id,l.record_id,new.agent_id from learning_tasks l join agent_tasks p on p.id=l.task_id
 where p.id=new.parent_task_id and p.workspace_id=new.workspace_id and p.site_id=new.site_id;
end;
pragma defer_foreign_keys = off;
