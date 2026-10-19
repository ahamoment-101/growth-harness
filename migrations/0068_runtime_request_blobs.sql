-- Content-addressed parts of model request receipts. Consecutive requests repeat the whole
-- conversation; storing each message, tool list and long prompt once turns quadratic growth linear.
create table if not exists agent_runtime_blobs (
  hash text primary key,
  value text not null
) without rowid;
