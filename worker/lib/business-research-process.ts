import { taskForRun, taskResumeBlock } from '../agent-runtime/task-store';
import { taskExecutionView } from '../agent-runtime/task-recovery';
import { redactRuntimeValue } from '../agent-runtime/protocol';

function object(value: string): Record<string, any> {
  try { return JSON.parse(value) || {}; } catch { return {}; }
}
export async function businessResearchProcess(db: D1Database, siteId: string, workspaceId: string, selection: { agentId: 'business_research' | 'strategy_research'; instanceId: string } = { agentId: 'business_research', instanceId: '' }) {
  const run = await db.prepare("select id,finished_at,status from agent_runs where site_id=? and workspace_id=? and agent_id=? and (?='' or agent_instance_id=?) order by created_at desc limit 1")
    .bind(siteId, workspaceId, selection.agentId, selection.instanceId, selection.instanceId).first<{id:string;finished_at:string;status:string}>();
  if (!run) return null;
  const task = await taskForRun(db, run.id);
  if (!task) return { run_id:run.id,status:run.status,reason:'',steps:[],pending:[],metrics:null };
  const [auditRows, operations, decisions, saved] = await Promise.all([
    db.prepare('select * from agent_runtime_audits where task_id=? order by number desc limit 20').bind(task.id).all<{number:number;status:string;operation_id:string;start_decision:number;end_decision:number;decision_json:string;created_at:string;resolved_at:string}>(),
    db.prepare('select turn,status,action_json,output_json,error,created_at,updated_at from agent_task_operations where task_id=? order by turn desc limit 200').bind(task.id)
      .all<{turn:number;status:string;action_json:string;output_json:string;error:string;created_at:string;updated_at:string}>(),
    db.prepare('select normal_decisions from agent_conversations where task_id=?').bind(task.id).first<{normal_decisions:number}>(),
    db.prepare("select count(*) as n from agent_task_operations where task_id=? and status='succeeded' and json_extract(action_json,'$.name')='save_business_document'").bind(task.id).first<{n:number}>(),
  ]);
  const audits = auditRows.results.reverse();
  const steps = operations.results.reverse().map(row => {
    const action=object(row.action_json); const args=action.input || {}; const output=object(row.output_json);
    const audit=audits.find(audit=>audit.operation_id && row.turn<=Number(audit.operation_id.split(':').at(-1))) || audits.at(-1);
    return {stage:audit?.number || 1,sequence:row.turn,tool:String(action.name || ''),status:row.status,purpose:String(args.purpose || ''),url:String(args.url || output.source?.url || ''),
      module:String(args.key || ''),version:output.version ?? null,source_id:String(args.source_id || output.id || ''),offset:args.offset || 0,
      characters:output.content_length ?? output.excerpt?.length ?? null,cached:false,error:String(output.error || row.error || ''),started_at:row.created_at,finished_at:row.updated_at};
  });
  const execution = await taskExecutionView(db, task);
  return redactRuntimeValue({run_id:run.id,task_id:task.id,status:task.status,outcome:task.outcome,reason:task.reason,
    execution_state:execution.execution_state,execution_id:execution.execution_id,started_at:task.created_at,finished_at:run.finished_at,
    metrics:{tool_calls:task.next_turn-1,model_calls:task.model_calls,decision_turns:decisions?.normal_decisions || 0,external_calls:task.external_calls,inference_units:task.reserved_tokens,saved_documents:saved?.n || 0},
    stages:audits.map(audit=>({number:audit.number,run_id:run.id,status:audit.status,decision:object(audit.decision_json),normal_decisions_start:audit.start_decision,
      normal_decisions_end:audit.end_decision,tool_calls:steps.filter(step=>step.stage===audit.number).length,
      pending:[],started_at:audit.created_at,finished_at:audit.resolved_at})),
    can_resume:['waiting','paused','failed'].includes(task.status) && !(await taskResumeBlock(db,task)),steps,pending:[]});
}
