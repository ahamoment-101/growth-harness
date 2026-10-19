-- UI read receipts, independent of task lifecycle or approval state.
create table team_status_receipts (
  workspace_id text not null,
  site_id text not null references sites(id) on delete cascade,
  agent_id text not null,
  task_id text not null references agent_tasks(id) on delete cascade,
  completed_at text not null,
  primary key (workspace_id, site_id, agent_id, task_id, completed_at)
);

-- Preserve previously acknowledged completions when upgrading from the Agent-wide watermark.
insert or ignore into team_status_receipts (workspace_id, site_id, agent_id, task_id, completed_at)
select t.workspace_id, t.site_id, t.agent_id, t.id, t.updated_at
from agent_tasks t join team_status_seen s
  on s.workspace_id=t.workspace_id and s.site_id=t.site_id and s.agent_id=t.agent_id
where t.status='completed' and t.updated_at <= s.seen_at
  and (t.outcome != 'unable_to_complete' or t.parent_task_id != '');
