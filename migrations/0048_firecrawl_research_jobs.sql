-- Provider execution receipts; a submitted job must never be silently resubmitted.
create table firecrawl_research_jobs (
  task_id text primary key references agent_tasks(id),
  root_task_id text not null references agent_tasks(id),
  status text not null check(status in ('reserved','submitting','processing','completed','failed','unknown','cancel_requested','cancelled')),
  job_id text not null default '',
  request_json text not null,
  raw_json text not null default '{}',
  reserved_credits integer not null,
  credits_used real,
  error text not null default '',
  created_at text not null,
  updated_at text not null
);
create index firecrawl_research_root on firecrawl_research_jobs(root_task_id);
