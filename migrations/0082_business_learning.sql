-- Business learning is independent of execution memory and parent task lifetime.
create table learning_records (
 id text primary key, workspace_id text not null, site_id text not null,
 origin_task_id text not null unique, version integer not null default 0,
 title text not null, status text not null default 'preparing', data_json text not null,
 created_at text not null, updated_at text not null
);
create index learning_records_site on learning_records(workspace_id,site_id,updated_at desc,id desc);
create index learning_records_status on learning_records(workspace_id,site_id,status,updated_at desc,id desc);
create table learning_tasks (
 task_id text primary key, record_id text not null references learning_records(id), agent_id text not null
);
create index learning_tasks_record on learning_tasks(record_id,task_id);
create table learning_operations (
 id text primary key, workspace_id text not null, site_id text not null, input_json text not null, result_json text not null, created_at text not null
);
create table learning_revisions (
 operation_id text not null references learning_operations(id), record_id text not null references learning_records(id),
 version integer not null, title text not null,status text not null,data_json text not null,created_at text not null,
 primary key(record_id,version), unique(operation_id,record_id)
);
create trigger learning_revision_guard before insert on learning_revisions begin
 select case when not exists(select 1 from learning_records r join learning_operations o on o.id=new.operation_id
  where r.id=new.record_id and r.version=new.version-1 and r.workspace_id=o.workspace_id and r.site_id=o.site_id)
  then raise(abort,'Learning revision conflict') end;
end;
create trigger learning_revision_apply after insert on learning_revisions begin
 update learning_records set version=new.version,title=new.title,status=new.status,data_json=new.data_json,updated_at=new.created_at where id=new.record_id;
end;
create table learning_uses (
 practice_id text not null references learning_records(id), experience_id text not null references learning_records(id),
 task_id text not null,agent_id text not null,observed_version integer not null,reason text not null,compatibility text not null,created_at text not null,
 primary key(practice_id,experience_id,task_id)
);
create index learning_uses_experience on learning_uses(experience_id,created_at,practice_id);
create table learning_evidence (
 id text primary key,record_id text not null references learning_records(id),kind text not null,source_ref text not null,payload_json text not null,created_at text not null
);
create index learning_evidence_record on learning_evidence(record_id,created_at,id);
create table learning_feedback (
 practice_id text not null references learning_records(id),experience_id text not null references learning_records(id),
 reward real, comparison_key text not null, evidence_refs_json text not null, evaluation_version integer not null,updated_at text not null,
 primary key(practice_id,experience_id)
);
create index learning_feedback_experience on learning_feedback(experience_id,practice_id);
create table learning_requests (
 id text primary key,record_id text not null references learning_records(id),phase text not null,
 payload_json text not null,status text not null default 'pending',failure_count integer not null default 0,
 observation_bound integer not null default 1,run_id text not null default '',error text not null default '',available_at text not null,created_at text not null,updated_at text not null
);
create index learning_requests_due on learning_requests(status,available_at,id);
create index learning_requests_record on learning_requests(record_id,created_at,id);
create table learning_failures (request_id text not null references learning_requests(id),receipt text not null,message text not null,created_at text not null,primary key(request_id,receipt));
create table learning_observations (
 id text primary key,record_id text not null references learning_records(id),job_id text not null,artifact_id text not null,
 url text not null,start_date text not null,end_date text not null,status text not null default 'pending',
 result_json text not null default 'null',available_at text not null,error text not null default '',created_at text not null,updated_at text not null
);
create index learning_observations_due on learning_observations(status,available_at,id);
create index learning_observations_record on learning_observations(record_id,id);

-- Capture formal checkpoints, not private conversations. Publication is recorded even after Leader closure.
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

create unique index learning_requests_run on learning_requests(run_id) where run_id!='';
create index learning_requests_order on learning_requests(record_id,status,created_at,id);
create index learning_requests_publication on learning_requests(phase,observation_bound,created_at);
create index learning_uses_task on learning_uses(task_id,created_at);

create trigger learning_evidence_identity before insert on learning_evidence begin
 select case when exists(select 1 from learning_evidence where id=new.id and (record_id!=new.record_id or payload_json!=new.payload_json))
 then raise(abort,'Learning evidence identity conflict') end;
end;

create trigger learning_use_guard before insert on learning_uses begin
 select case when not exists(select 1 from learning_records p join learning_records h on h.id=new.experience_id
   join learning_tasks t on t.task_id=new.task_id and t.record_id=p.id
   where p.id=new.practice_id and p.id!=h.id and p.workspace_id=h.workspace_id and p.site_id=h.site_id and h.version=new.observed_version)
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

create index learning_evidence_page on learning_evidence(record_id,id);
create index learning_uses_practice_page on learning_uses(practice_id,(experience_id||':'||task_id));
create index learning_uses_adopted_page on learning_uses(experience_id,(practice_id||':'||task_id));

create index learning_evidence_source on learning_evidence(record_id,source_ref,created_at desc,id desc);
