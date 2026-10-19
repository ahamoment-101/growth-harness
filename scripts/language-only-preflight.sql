-- Read-only. Run against the intended database before the language-only cutover.
select workspace_id,site_id,locale,kind,normalized_name,count(*) as conflicting_records
from keyword_library_entries group by workspace_id,site_id,locale,kind,normalized_name having count(*)>1;
select workspace_id,site_id,locale,operation_id,count(*) as conflicting_operations
from keyword_library_logs group by workspace_id,site_id,locale,operation_id having count(*)>1;
select site_id,locale,normalized_term,count(*) as conflicting_records
from seo_keywords group by site_id,locale,normalized_term having count(*)>1;
-- All these agents can hold a pinned tool contract touched by the change.
select id,agent_id,definition_version,status,active_run_id from agent_tasks
where agent_id in ('growth_leader','strategy_research','keyword_research','topic_decision','content_production','article_production','content_review')
and status not in ('completed','cancelled');
select locale,count(*) as records from keyword_library_entries group by locale;
select count(*) as entries from keyword_library_entries;
select count(*) as memberships from keyword_library_memberships;
select count(*) as topic_links from keyword_library_topic_links;
select count(*) as logs from keyword_library_logs;
pragma foreign_key_check;
