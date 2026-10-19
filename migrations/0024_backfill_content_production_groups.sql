-- Handed-off topic groups created before the content-production Agent existed
-- must remain actionable instead of becoming orphaned legacy draft jobs.

insert into content_production_groups (
  id, workspace_id, site_id, decision_group_id, parent_run_id, status,
  total_items, ready_items, failed_items, review_round, review_json, error,
  created_at, updated_at
)
select
  'backfill-' || r.id,
  r.workspace_id,
  r.site_id,
  r.id,
  '',
  'needs_attention',
  count(j.id),
  0,
  count(j.id),
  0,
  '{}',
  'Existing article tasks were handed off before the content-production Agent was enabled. Retry this group to continue.',
  r.created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
from topic_decision_results r
join jobs j on j.decision_group_id = r.id and coalesce(j.production_group_id, '') = ''
where r.status = 'handed_off'
  and not exists (select 1 from content_production_groups g where g.decision_group_id = r.id)
group by r.id, r.workspace_id, r.site_id, r.created_at
having count(j.id) > 0
  and count(j.id) = sum(case when j.status = 'failed' then 1 else 0 end);

update jobs
set production_group_id = 'backfill-' || decision_group_id,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
where coalesce(production_group_id, '') = ''
  and decision_group_id is not null
  and exists (
    select 1 from content_production_groups g
    where g.id = 'backfill-' || jobs.decision_group_id
      and g.decision_group_id = jobs.decision_group_id
  );
