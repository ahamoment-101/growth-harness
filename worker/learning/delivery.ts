import type { D1Database } from '@cloudflare/workers-types';
import { taskDataJson } from '../agent-runtime/task-store';
import { taskSubjectsJson, type TaskSubject } from '../agent-runtime/task-subjects';

/** Topic-domain bridge: appended to the formal submission's own transaction.
 * Version names the immutable submission operation, not a later mutable status.
 * No model parses IDs, changes task input scope, or decides whether to save this.
 */
export function topicDeliveryStatements(db: D1Database, input: {
  workspaceId: string; siteId: string; runId: string; operationId: string;
  groupId: string; subjects: TaskSubject[]; snapshot: unknown;
}) {
  const id = `delivery:${input.operationId}`;
  const subjects = taskSubjectsJson(input.subjects)!;
  return [
    db.prepare(`insert or ignore into learning_evidence(id,record_id,kind,source_ref,payload_json,created_at,attribution_json)
      select ?,l.record_id,'delivery',t.id,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        json_object('task_id',t.id,'parent_task_id',t.parent_task_id,'assignment_id',t.assignment_id,'subjects',json(?))
      from agent_tasks t join learning_tasks l on l.task_id=t.id join learning_records r on r.id=l.record_id
      join topic_decision_results g on g.run_id=t.active_run_id
      where t.active_run_id=? and t.workspace_id=? and t.site_id=? and r.workspace_id=t.workspace_id and r.site_id=t.site_id
        and g.id=? and g.submission_operation_id=? and g.workspace_id=t.workspace_id and g.site_id=t.site_id`)
      .bind(id, taskDataJson({ receipt_id: input.operationId, snapshot: input.snapshot }), subjects,
        input.runId, input.workspaceId, input.siteId, input.groupId, input.operationId),
    db.prepare(`insert or ignore into learning_requests(id,record_id,phase,payload_json,available_at,created_at,updated_at,observation_bound)
      select id,record_id,'record',json_object('evidence_ref',id),created_at,created_at,created_at,1 from learning_evidence where id=?`).bind(id),
  ];
}
