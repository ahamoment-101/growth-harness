import { ToolContractError } from './tool-failure';
import { z } from 'zod';
import type { D1Database } from '@cloudflare/workers-types';
import { taskDataJson, TaskStateError, type AgentTask, type TaskOperation } from './task-store';
import type { RuntimeTool } from './tools';

export const AUDIT_TOOL = 'resolve_execution_audit';
export const AUDIT_INTERVAL = 30;
export const AUDIT_INSTRUCTIONS = `This is an autonomous business task with one continuous conversation. Every 30 normal decisions the Runtime will ask you to audit progress. During an audit, read tools remain available but business mutations are suspended. Use resolve_execution_audit to continue automatically for another 30 decisions or finish with an honest outcome, saved artifact references and unresolved issues. Audit finish does not submit business artifacts. Tool errors are observations: use their details to correct your next action. Never blindly repeat an operation whose effects are unknown.`;
export const auditDecisionSchema = z.object({
  decision: z.enum(['continue', 'finish']),
  reason: z.string().trim().min(1),
  progress: z.string().trim().min(1),
  remaining_work: z.string(),
  next_stage_method: z.string(),
  outcome: z.enum(['completed', 'partial', 'unable_to_complete']),
  artifact_refs: z.array(z.string().min(1)),
  unresolved_issues: z.array(z.string()),
}).superRefine((value, ctx) => {
  if (value.decision === 'continue' && (!value.remaining_work.trim() || !value.next_stage_method.trim())) {
    ctx.addIssue({ code: 'custom', path: ['next_stage_method'], message: 'Continuation must identify remaining work and the next method' });
  }
});
export type AuditDecision = z.infer<typeof auditDecisionSchema>;
export type RuntimeAudit = { task_id: string; number: number; start_decision: number; end_decision: number; status: 'normal' | 'auditing' | 'continued' | 'finished'; decision_json: string; operation_id: string };
export async function currentAudit(db: D1Database, taskId: string): Promise<RuntimeAudit> {
  const row = await db.prepare('select * from agent_runtime_audits where task_id=? order by number desc limit 1').bind(taskId).first<RuntimeAudit>();
  if (!row) throw new TaskStateError('Runtime audit state is missing');
  return row;
}
export async function prepareAudit(db: D1Database, task: AgentTask): Promise<RuntimeAudit> {
  await db.prepare(`insert or ignore into agent_runtime_audits(task_id,number,start_decision,end_decision,status,created_at)
    values(?,1,0,?,'normal',?)`).bind(task.id, AUDIT_INTERVAL, new Date().toISOString()).run();
  await db.prepare(`update agent_runtime_audits set status='auditing' where task_id=? and status='normal'
    and end_decision <= (select normal_decisions from agent_conversations where task_id=?)`).bind(task.id, task.id).run();
  return currentAudit(db, task.id);
}
export function executionAuditTool(db: D1Database, task?: AgentTask, operation?: TaskOperation, completionTools: readonly string[] = []): RuntimeTool {
  return { name: AUDIT_TOOL, version: 1, description: 'Resolve the current execution audit: continue autonomously for 30 normal decisions, or finish with saved results and unresolved issues. Available only when the Runtime explicitly enters audit mode.',
    capability: 'read', approval: 'never', retryable: false, timeoutMs: 10000, replaySafety: 'idempotent', executionMode: 'durable_call',
    inputSchema: auditDecisionSchema, outputSchema: auditDecisionSchema,
    execute: async input => {
      if (!task || !operation) throw new TaskStateError('Audit needs a persisted operation');
      const decision = auditDecisionSchema.parse(input);
      const resolved = await db.prepare("select decision_json from agent_runtime_audits where task_id=? and operation_id=? and status in ('continued','finished')").bind(task.id, operation.id).first<{decision_json:string}>();
      if (resolved) return auditDecisionSchema.parse(JSON.parse(resolved.decision_json));
      const audit = await currentAudit(db, task.id);
      if (audit.status !== 'auditing') throw new Error('No active execution audit; continue normal task work');
      if (decision.decision === 'finish' && decision.outcome === 'completed' && completionTools.length) {
        const proof = await db.prepare(`select 1 from agent_task_operations where task_id=? and status='succeeded'
          and json_extract(action_json,'$.name') in (${completionTools.map(() => '?').join(',')})
          and coalesce(json_extract(output_json,'$.accepted'),1)!=0 limit 1`).bind(task.id, ...completionTools).first();
        if (!proof) throw new ToolContractError('Audit finish cannot replace the required business submission', {
          kind: 'invalid_request', effects: 'none', issues: [{ path: ['outcome'], message: 'No saved business submission exists' }],
          guidance: 'Continue to submit the actual business deliverable, or finish with partial/unable_to_complete and honest gaps.',
        });
      }
      const at = new Date().toISOString();
      const encoded = taskDataJson(decision);
      const gate = `exists(select 1 from agent_tasks where id=? and active_run_id=? and epoch=? and status='running' and next_turn=?)`;
      const bindings = [task.id, task.active_run_id, task.epoch, operation.turn];
      const result = await db.batch([
        db.prepare(`update agent_runtime_audits set status=?,operation_id=?,decision_json=?,resolved_at=?
          where task_id=? and number=? and status='auditing' and ${gate}`)
          .bind(decision.decision === 'continue' ? 'continued' : 'finished', operation.id, encoded, at, task.id, audit.number, ...bindings),
        db.prepare(`update agent_task_operations set status='succeeded',output_json=?,updated_at=? where id=? and ${gate}
          and exists(select 1 from agent_runtime_audits where task_id=? and number=? and operation_id=?)`)
          .bind(encoded, at, operation.id, ...bindings, task.id, audit.number, operation.id),
        ...(decision.decision === 'continue' ? [db.prepare(`insert or ignore into agent_runtime_audits(task_id,number,start_decision,end_decision,status,created_at)
          select ?,?,?,?,'normal',? where ${gate} and exists(select 1 from agent_runtime_audits where task_id=? and number=? and operation_id=?)`)
          .bind(task.id, audit.number + 1, audit.end_decision, audit.end_decision + AUDIT_INTERVAL, at, ...bindings, task.id, audit.number, operation.id)] : []),
        db.prepare(`update agent_tasks set next_turn=next_turn+1,last_operation_id=?,status=?,outcome=?,reason=?,output_json=?,updated_at=?
          where id=? and ${gate} and exists(select 1 from agent_task_operations where id=? and status='succeeded')`)
          .bind(operation.id, decision.decision === 'finish' ? 'completed' : 'running', decision.decision === 'finish' ? decision.outcome : '',
            decision.decision === 'finish' ? decision.reason : '', decision.decision === 'finish' ? encoded : task.output_json,
            at, task.id, ...bindings, operation.id),
      ]);
      if (!result[0].meta.changes) throw new TaskStateError('Audit decision lost execution authority');
      return decision;
    },
  };
}
