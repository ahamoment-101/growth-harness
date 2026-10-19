-- Recoverable, schema-level model results for durable Workflow turn replay.

alter table agent_model_calls add column result_json text not null default '{}';
