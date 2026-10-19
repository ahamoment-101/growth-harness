-- When a person last looked at each classroom team member; results finished before then
-- no longer show as "just done".
create table if not exists team_status_seen (
  workspace_id text not null,
  site_id text not null references sites(id) on delete cascade,
  agent_id text not null,
  seen_at text not null,
  primary key (workspace_id, site_id, agent_id)
);

-- The team status reads each Agent's latest Task start per site.
create index if not exists agent_tasks_site_agent_created on agent_tasks(workspace_id, site_id, agent_id, created_at);
