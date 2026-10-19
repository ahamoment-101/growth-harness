import type { AgentActivityPage } from '../../shared/agent-activity';
import type { PanelTask } from '../../shared/agent-panel';
import { agentRoster } from '../agent-runtime/definitions';
import type { TeamScope } from './signals';
import { titledTasks } from './panel';

export function activityCursor(cursor: string): string[] {
  if (!cursor) return ['', ''];
  const value: unknown = JSON.parse(cursor);
  if (!Array.isArray(value) || value.length !== 2 || !value.every(item => typeof item === 'string' && item.length <= 300)) throw new Error('Invalid activity cursor');
  return value;
}

/** Read-only business milestones. A waiting checkpoint proves delivery, not task completion. */
export async function readAgentActivity(scope: TeamScope, cursor = '', agentId = ''): Promise<AgentActivityPage> {
  const before = activityCursor(cursor);
  const agents = agentRoster();
  const ids = agents.filter(agent => !agentId || agent.agentId === agentId).map(agent => agent.agentId);
  if (!ids.length) return { entries: [], agents, next_cursor: null };
  // Each milestone kind reads only its newest rows through an index, then the pages merge.
  // Deeper pages read the rows newer than the cursor as well; the polled first page stays bounded.
  const columns = 't.agent_id,t.active_run_id,t.status,t.outcome,t.reason,t.agent_instance_id,t.parent_task_id,t.created_at,t.updated_at,t.goal_json,t.assignment_id,t.id';
  type Row = PanelTask & { goal_json: string; assignment_id: string; event_id: string; task_id: string; kind: 'started' | 'completed'; at: string };
  // Walk the site's timeline index newest first and stop at a page. With several Agents, seeking per Agent
  // (the planner's choice for a plain `agent_id in`) reads every task of those Agents to sort them.
  const agentFilter = ids.length === 1 ? "t.agent_id=json_extract(?3,'$[0]')" : '+t.agent_id in (select value from json_each(?3))';
  const scoped = `t.workspace_id=?1 and t.site_id=?2 and ${agentFilter}`;
  const after = (at: string, event: string) => `(?4='' or ${at}<?4 or (${at}=?4 and ${event}<?5))`;
  const bind = [scope.workspaceId, scope.siteId, JSON.stringify(ids), before[0], before[1]];
  const delivering = ids.filter(id => id === 'article_production' || id === 'content_review');
  const [starts, finishes] = await Promise.all([
    scope.db.prepare(`select '0:start:'||t.id as event_id,t.id as task_id,'started' as kind,t.created_at as at,${columns} from agent_tasks t
      where ${scoped} and ${after('t.created_at', "'0:start:'||t.id")} order by t.created_at desc,t.id desc limit 41`).bind(...bind).all<Row>(),
    scope.db.prepare(`select '1:finish:'||t.id as event_id,t.id as task_id,'completed' as kind,t.updated_at as at,${columns} from agent_tasks t
      where ${scoped} and t.status='completed' and t.outcome in ('completed','no_change','no_findings','awaiting_human_review')
        and ${after('t.updated_at', "'1:finish:'||t.id")} order by t.updated_at desc,t.id desc limit 41`).bind(...bind).all<Row>(),
  ]);
  // A delivery older than a full page of starts cannot be on this page. A checkpoint is written in the
  // same batch that stamps its task's updated_at, which only moves forward, so its task was updated at
  // or after the delivery: read only tasks updated since the floor, then their checkpoints.
  const floor = starts.results.length === 41 ? starts.results[40].at : '';
  const deliveries = delivering.length ? await scope.db.prepare(`select '1:delivery:'||c.id as event_id,t.id as task_id,'completed' as kind,c.created_at as at,${columns}
      from agent_tasks t join agent_task_checkpoints c on c.task_id=t.id join agent_task_operations o on o.id=c.operation_id and +o.task_id=t.id
      where t.workspace_id=?1 and t.site_id=?2 and t.updated_at>=?6 and +t.agent_id in (select value from json_each(?7))
        and c.created_at>=?6 and o.status='succeeded' and (
        (t.agent_id='article_production' and json_extract(o.action_json,'$.name') in ('deliver_article','submit_article'))
        or (t.agent_id='content_review' and json_extract(o.action_json,'$.name')='submit_content_review'))
        and ${after('c.created_at', "'1:delivery:'||c.id")} order by c.created_at desc,c.id desc limit 41`)
    .bind(...bind, floor, JSON.stringify(delivering)).all<Row>() : { results: [] as Row[] };
  const rows = { results: [...starts.results, ...finishes.results, ...deliveries.results]
    .sort((a, b) => a.at === b.at ? (a.event_id < b.event_id ? 1 : -1) : (a.at < b.at ? 1 : -1)).slice(0, 41) };
  const page = rows.results.slice(0, 40);
  const titles = new Map((await titledTasks(scope, [...new Map(page.map(row => [row.id, row])).values()])).map(task => [task.id, task.display_title || 'Work tasks']));
  const last = page.at(-1);
  return {
    agents,
    entries: page.map(row => ({ id: row.event_id, task_id: row.task_id, agent_id: row.agent_id,
      agent_name: agents.find(agent => agent.agentId === row.agent_id)!.name,
      kind: row.kind, at: row.at, title: `${row.kind === 'started' ? 'started' : 'completed'} ${titles.get(row.id)?.replace(/^(?:Write article|\u64b0\u5199\u6587\u7ae0)/, 'Article writing').replace(/^(?:Review article|\u5ba1\u6838\u6587\u7ae0)/, 'Article review').replace(/^(?:Create content group|\u521b\u4f5c\u5185\u5bb9\u7ec4)$/, 'Content group creation')}` })),
    next_cursor: rows.results.length > 40 && last ? JSON.stringify([last.at, last.event_id]) : null,
  };
}
