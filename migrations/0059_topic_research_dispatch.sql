-- A topic research request is dispatched to strategy research by the scheduled dispatcher.
-- research_run_id links the strategy task it started; research_dispatch_error ends dispatch attempts.
alter table topic_decision_results add column research_run_id text not null default '';
alter table topic_decision_results add column research_dispatch_error text not null default '';
-- Requests saved before automatic dispatch existed are not started retroactively.
update topic_decision_results set research_dispatch_error = 'Saved before automatic dispatch; not started'
  where status = 'research_needed';
create index if not exists topic_decision_results_research_dispatch
  on topic_decision_results(status, research_run_id, research_dispatch_error);
