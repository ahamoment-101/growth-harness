-- The historical column name is retained, but a continuous Task's Run cannot change.
create trigger continuous_task_run_immutable before update of active_run_id on agent_tasks
when old.runtime_version=2 and new.active_run_id != old.active_run_id
BEGIN select raise(abort,'Continuous Task Run identity is immutable'); END;

create trigger continuous_task_single_run before insert on agent_task_runs
when exists(select 1 from agent_tasks t where t.id=new.task_id and t.runtime_version=2
  and (t.active_run_id!=new.run_id or exists(select 1 from agent_task_runs r where r.task_id=t.id and r.run_id!=new.run_id)))
BEGIN select raise(abort,'Continuous Task has exactly one Run'); END;

create trigger continuous_task_run_link_immutable before update of task_id,run_id on agent_task_runs
when (new.task_id!=old.task_id or new.run_id!=old.run_id)
  and exists(select 1 from agent_tasks where id in (old.task_id,new.task_id) and runtime_version=2)
BEGIN select raise(abort,'Continuous Task Run link is immutable'); END;

create trigger continuous_execution_identity before insert on agent_runtime_executions
when not exists(select 1 from agent_tasks t where t.id=new.task_id and t.active_run_id=new.run_id)
BEGIN select raise(abort,'Execution must use the Task Run'); END;
