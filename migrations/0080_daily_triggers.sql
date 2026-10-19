-- One daily trigger per site. More action values can be added without changing the scheduler.
create table daily_triggers (
  site_id text primary key references sites(id) on delete cascade,
  workspace_id text not null,
  enabled integer not null default 0 check(enabled in (0,1)),
  task_mode text not null default 'scheduled' check(task_mode='scheduled'),
  action text not null default 'start_topic_batch' check(action='start_topic_batch'),
  local_time text not null default '09:00',
  timezone text not null default 'Asia/Shanghai' check(timezone='Asia/Shanghai'),
  next_due_at text not null default '',
  updated_at text not null
);
create index daily_triggers_due on daily_triggers(enabled,next_due_at,site_id);

-- The local date is the occurrence identity, so retries cannot create another request.
create table daily_trigger_fires (
  site_id text not null references daily_triggers(site_id) on delete cascade,
  local_date text not null,
  workspace_id text not null,
  action text not null,
  input_id text not null unique,
  created_at text not null,
  delivered_at text not null default '',
  primary key(site_id,local_date)
);
create index daily_trigger_fires_pending on daily_trigger_fires(delivered_at,created_at,site_id);
