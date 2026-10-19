import { describe, expect, it } from 'vitest';
import { taskTestDb } from '../agent-runtime/task-test-db';
import { attachTask } from '../agent-runtime/task-store';
import { agentDefinition } from '../agent-runtime/definitions';
import { businessResearchProcess } from './business-research-process';

describe('business research process projection', () => {
  it('scopes access to the website and workspace', async () => {
    const { db, run } = taskTestDb(); run();
    expect(await businessResearchProcess(db, 's', 'another-workspace')).toBeNull();
  });
  it('shows persisted audit and rejected actions without exposing private reasoning or document payloads', async () => {
    const { db, sqlite, run } = taskTestDb();
    const r = run(); await attachTask(db, r, agentDefinition('strategy_research'));
    sqlite.exec("update agent_runs set agent_id='business_research'; update agent_tasks set status='running',outcome='',reason='',next_turn=2;");
    sqlite.prepare('insert into agent_conversations(task_id,protocol_version,instructions,context_json,created_at) values(?,1,?,?,?)').run(r.id, 'private context', '{}', 'now');
    sqlite.prepare("insert into agent_conversation_messages(task_id,sequence,message_key,role,message_json,created_at) values(?,1,'m','assistant',?,'now')").run(r.id, JSON.stringify({ content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'toolCall', id: 'blocked', name: 'save_business_document', arguments: { key: 'conversion', markdown: 'private document payload' } }] }));
    sqlite.prepare("insert into agent_task_operations(id,task_id,turn,status,context_json,action_json,output_json,error,created_at,updated_at) values(?,?,1,'failed','{}',?,?,?,'now','now')").run(`${r.id}:1`,r.id,JSON.stringify({name:'save_business_document',input:{key:'conversion',markdown:'private document payload'}}),JSON.stringify({executed:false,effects:'none'}),'Invalid module reference');
    sqlite.prepare("insert into agent_runtime_audits(task_id,number,start_decision,end_decision,status,created_at) values(?,1,0,30,'auditing','now')").run(r.id);
    const result = await businessResearchProcess(db, 's', 'w');
    expect(result).toMatchObject({ status: 'running', metrics: { tool_calls: 1 }, steps: [{ tool: 'save_business_document', module: 'conversion', status: 'failed', error: 'Invalid module reference' }], stages:[{number:1,status:'auditing'}] });
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
