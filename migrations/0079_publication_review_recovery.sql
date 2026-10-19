-- A reconciled publish can finish after its original Agent tool call failed.
-- Close only the review claim belonging to that same approval operation.
create trigger publication_review_completed_after_recovery after update of status on jobs
when old.status='publishing' and new.status='published' and new.publication_operation_id!=''
BEGIN
  update agent_event_deliveries set status='completed',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    where event_id='article-review:'||new.id||':'||new.current_artifact_id
      and operation_id=new.publication_operation_id and decision='publish'
      and status in ('pending','delivered','waiting');
END;
