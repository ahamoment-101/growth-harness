-- Separate dispatch ownership from Task write ownership. Duplicate cron events
-- share a deterministic successor, but must not race its startup transitions.
alter table agent_task_recoveries add column lease_until text not null default '';
alter table agent_task_recoveries add column dispatch_failures integer not null default 0;
