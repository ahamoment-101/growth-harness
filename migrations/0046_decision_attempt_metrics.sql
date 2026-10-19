-- Unknown for historical decisions; distinguish schema repair from transport attempts.
alter table agent_decision_results add column provider_attempts integer;
alter table agent_decision_results add column structural_repairs integer;
