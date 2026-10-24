-- Evidence keeps an immutable attribution snapshot, independent of later assignments.
alter table learning_evidence add column attribution_json text not null default '{"subjects":[]}';
drop trigger learning_task_report;
create trigger learning_task_report after update of status on agent_tasks
when new.status!=old.status and new.status!='running' begin
 insert or ignore into learning_evidence(id,record_id,kind,source_ref,payload_json,created_at,attribution_json)
 select 'report:'||new.id||':'||new.execution_id||':'||new.status||':'||new.assignment_id,l.record_id,'report',new.id,
 json_object('agent_id',new.agent_id,'status',new.status,'reason',new.reason,'output',json(new.output_json)),strftime('%Y-%m-%dT%H:%M:%fZ','now'),
 json_object('task_id',new.id,'parent_task_id',new.parent_task_id,'assignment_id',new.assignment_id,
 'parent_assignment_id',new.parent_assignment_id,'subjects',json(new.subjects_json))
 from learning_tasks l where l.task_id=new.id;
 insert or ignore into learning_requests(id,record_id,phase,payload_json,available_at,created_at,updated_at,observation_bound)
 select e.id,e.record_id,'record',json_object('evidence_ref',e.id),e.created_at,e.created_at,e.created_at,1 from learning_evidence e
 where e.id='report:'||new.id||':'||new.execution_id||':'||new.status||':'||new.assignment_id;
end;

-- Domain bridge: publication identities come from persisted jobs/artifacts, never prose.
create trigger learning_publication_attribution after insert on learning_evidence
when new.kind='publication' begin
 update learning_evidence set attribution_json=json_object('subjects',json_array(json_object(
   'type','job','id',json_extract(new.payload_json,'$.job_id'),'version',json_extract(new.payload_json,'$.artifact_id'))))
 where id=new.id and exists(select 1 from jobs j join content_artifacts a on a.job_id=j.id
   join learning_records r on r.id=new.record_id
   where j.id=json_extract(new.payload_json,'$.job_id') and a.id=json_extract(new.payload_json,'$.artifact_id') and j.site_id=r.site_id);
end;
-- A creator assignment cannot name its future artifact. Enrich its report only
-- from the formal delivery receipt and a real artifact belonging to that job.
create trigger learning_delivery_attribution after insert on learning_evidence
when new.kind='report' and json_extract(new.payload_json,'$.output.artifact_id') is not null begin
 update learning_evidence set attribution_json=json_set(new.attribution_json,'$.subjects',json((
   select json_group_array(json_object('type',json_extract(s.value,'$.type'),'id',json_extract(s.value,'$.id'),
     'version',case when json_extract(s.value,'$.type')='job' and json_extract(s.value,'$.id')=json_extract(new.payload_json,'$.output.job_id')
       then coalesce(json_extract(s.value,'$.version'),json_extract(new.payload_json,'$.output.artifact_id'))
       else json_extract(s.value,'$.version') end)) from json_each(new.attribution_json,'$.subjects') s)))
 where id=new.id and exists(select 1 from content_artifacts a join jobs j on j.id=a.job_id join learning_records r on r.id=new.record_id
   where a.id=json_extract(new.payload_json,'$.output.artifact_id') and j.id=json_extract(new.payload_json,'$.output.job_id') and j.site_id=r.site_id);
end;
-- Only backfill relationships proven by saved structured identities. Historical
-- deferred reports lack artifact receipts: do not guess a candidate from today's job.
update learning_evidence as e set attribution_json=json_object('task_id',e.source_ref,
 'parent_task_id',t.parent_task_id,'subjects',json_array(json_object('type','job','id',j.id,'version',null)))
from agent_tasks t join jobs j on j.id=json_extract(t.goal_json,'$.job_id')
join learning_records r on r.workspace_id=t.workspace_id and r.site_id=t.site_id
where e.kind='report' and e.source_ref=t.id and e.record_id=r.id and j.site_id=r.site_id;
update learning_evidence as e set attribution_json=json_object('subjects',json_array(json_object('type','job','id',j.id,'version',a.id)))
from jobs j join content_artifacts a on a.job_id=j.id join learning_records r on r.site_id=j.site_id
where e.kind='publication' and e.record_id=r.id and j.id=json_extract(e.payload_json,'$.job_id') and a.id=json_extract(e.payload_json,'$.artifact_id');
