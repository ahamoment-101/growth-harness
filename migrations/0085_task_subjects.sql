-- Opaque, host-owned subject references. Runtime does not interpret domain types.
alter table agent_tasks add column subjects_json text not null default '[]';
alter table agent_tasks add column parent_assignment_id text not null default '';
alter table agent_task_assignments add column subjects_json text;
alter table agent_task_assignments add column parent_assignment_id text not null default '';
create trigger runtime_capture_assignment_parent after insert on agent_task_assignments begin
 update agent_task_assignments set parent_assignment_id=coalesce((select p.assignment_id from agent_tasks t
   join agent_tasks p on p.id=t.parent_task_id and p.workspace_id=t.workspace_id and p.site_id=t.site_id
   where t.id=new.task_id),'') where id=new.id;
end;
create trigger runtime_inherit_subjects after insert on agent_tasks
when new.parent_task_id!='' begin
 update agent_tasks set subjects_json=coalesce((select subjects_json from agent_tasks p
   where p.id=new.parent_task_id and p.workspace_id=new.workspace_id and p.site_id=new.site_id),'[]'),
   parent_assignment_id=coalesce((select assignment_id from agent_tasks p
   where p.id=new.parent_task_id and p.workspace_id=new.workspace_id and p.site_id=new.site_id),'') where id=new.id;
end;
create trigger runtime_assignment_subject_identity before insert on agent_task_assignments begin
 select case when exists(select 1 from agent_task_assignments a where a.id=new.id
   and (a.task_id!=new.task_id or coalesce(a.subjects_json,'null')!=coalesce(new.subjects_json,'null')))
   then raise(abort,'Assignment subject identity conflict') end;
end;
create trigger runtime_apply_assignment_subjects after update of assignment_id on agent_tasks
when new.assignment_id!=old.assignment_id begin
 select case when not exists(select 1 from agent_task_assignments a where a.id=new.assignment_id and a.task_id=new.id)
   then raise(abort,'Assignment belongs to another task') end;
 update agent_tasks set subjects_json=coalesce((select subjects_json from agent_task_assignments where id=new.assignment_id),old.subjects_json),
   parent_assignment_id=(select parent_assignment_id from agent_task_assignments where id=new.assignment_id) where id=new.id;
end;

create trigger runtime_assignment_subject_immutable before update of subjects_json,task_id on agent_task_assignments
when new.task_id!=old.task_id or coalesce(new.subjects_json,'null')!=coalesce(old.subjects_json,'null') begin
 select raise(abort,'Assignment subject snapshot is immutable');
end;
