-- Decision results are cached per execution scope, not per Run.
--
-- `agent_model_calls` keys its cache on (run_id, turn). An Agent that runs one
-- decision loop per locale inside a single Run restarts the turn counter for
-- every scope, so the second scope replayed the first scope's actions without
-- ever calling the model. Workflow step names already carry the scope; only the
-- D1 cache did not.
--
-- `unique (run_id, turn)` cannot be widened in place under SQLite, so the cache
-- moves to its own table. `agent_model_calls` stays as-is: it keeps receiving
-- unscoped decisions, so an older Worker can still replay an in-flight Run
-- during a rollback, and it remains the coalesce fallback for usage aggregation.
create table if not exists agent_decision_results (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  execution_scope text not null default '',
  turn integer not null,
  provider text not null,
  model text not null,
  result_json text not null default '{}',
  created_at text not null,
  unique (run_id, execution_scope, turn)
);

create index if not exists idx_agent_decision_results_run
  on agent_decision_results(run_id, execution_scope, turn);
