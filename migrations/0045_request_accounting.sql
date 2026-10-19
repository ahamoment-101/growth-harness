-- Nullable measurements distinguish legacy samples from complete instrumentation.
alter table agent_request_samples add column sql_statements integer;
alter table agent_request_samples add column complete integer not null default 0;
