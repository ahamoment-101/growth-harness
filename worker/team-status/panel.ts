import { pendingWork, workInteractions } from '../agent-work';
import { readWorkStream } from '../agent-work/stream';
import { strategyDocumentBody, type CabinetDocument } from '../../shared/cabinet-document';
import type { AgentPanelDetail, AgentPanelList, PanelTask, PanelTodo } from '../../shared/agent-panel';
import { getAgentRun } from '../agent-runtime/store';
import { taskForRun } from '../agent-runtime/task-store';
import { taskExecutionView } from '../agent-runtime/task-recovery';
import { readWorkingDraft } from '../agent-runtime/working-draft';
import { readRuntimeJson } from '../agent-runtime/runtime-content';
import { redactRuntimeValuePreservingSize } from '../agent-runtime/protocol';
import type { TeamScope } from './signals';

const columns = 'id, agent_id, active_run_id, status, outcome, reason, agent_instance_id, parent_task_id, created_at, updated_at';
const titleColumns = `${columns}, goal_json, assignment_id`;
const pageSize = 30;
type TitleTask = PanelTask & { goal_json: string; assignment_id: string };

function titleText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 140 ? `${normalized.slice(0, 140).trimEnd()}…` : normalized;
}

function reference(value: unknown): string { return typeof value === 'string' ? value : ''; }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function languageName(locale: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) || locale; }
  catch { return locale; }
}

function taskTitle(agentId: string, task: TitleTask, goal: Record<string, unknown>, businessTitle = ''): string {
  const question = titleText(goal.research_question);
  const scope = record(goal.scope);
  const locale = titleText(scope.locale || goal.locale);
  switch (agentId) {
    case 'strategy_research': {
      const language = task.agent_instance_id.startsWith('strategy:') ? task.agent_instance_id.slice(9) : locale;
      return language ? `${languageName(language)} market · SEO Strategy` : 'Research market and content strategy';
    }
    case 'deep_research': return question ? `Topic deep research · ${question}` : 'Topic deep research';
    case 'keyword_research': return question ? `Keyword research · ${question}` : 'Research search demand';
    case 'topic_decision': return locale ? `${languageName(locale)} topic selection` : 'Plan content topics';
    case 'content_production': return businessTitle ? `Content creation · ${businessTitle}` : 'Create content group';
    case 'article_production': return businessTitle ? `Write article · ${businessTitle}` : 'Write the article';
    case 'content_review': return businessTitle ? `Review article · ${businessTitle}` : 'Review the article';
    default: return 'Work tasks';
  }
}

/** Resolve presentation titles from existing briefs and scoped business records. */
export async function titledTasks(scope: TeamScope, rows: TitleTask[]): Promise<PanelTask[]> {
  if (!rows.length) return [];
  const { db, workspaceId, siteId } = scope;
  const goals = await Promise.all(rows.map(async row => record(await readRuntimeJson(db, row.goal_json))));
  const groupIds = [...new Set(goals.map(goal => reference(goal.group_id)).filter(Boolean))];
  const jobIds = [...new Set(goals.map(goal => reference(goal.job_id)).filter(Boolean))];
  const groupNames = new Map<string, string>();
  const jobNames = new Map<string, string>();
  if (rows.some(row => row.agent_id === 'content_production') && groupIds.length) {
    const result = await db.prepare(`select g.id, r.group_goal from content_production_groups g
      join topic_decision_results r on r.id=g.decision_group_id and r.workspace_id=g.workspace_id and r.site_id=g.site_id
      where g.workspace_id=? and g.site_id=? and g.id in (${groupIds.map(() => '?').join(',')})`)
      .bind(workspaceId, siteId, ...groupIds).all<{ id: string; group_goal: string }>();
    for (const item of result.results) groupNames.set(item.id, titleText(item.group_goal));
  }
  if (rows.some(row => ['article_production', 'content_review'].includes(row.agent_id)) && jobIds.length) {
    const result = await db.prepare(`select j.id, j.en_title, j.pt_title, i.title_direction, t.title_hint
      from jobs j left join topic_decision_items i on i.id=j.decision_item_id
      left join topics t on t.id=j.topic_id
      where j.site_id=? and j.id in (${jobIds.map(() => '?').join(',')})`)
      .bind(siteId, ...jobIds).all<{ id: string; en_title: string | null; pt_title: string | null; title_direction: string | null; title_hint: string | null }>();
    for (const item of result.results) jobNames.set(item.id, titleText(item.title_direction) || titleText(item.en_title) || titleText(item.pt_title) || titleText(item.title_hint));
  }
  // Seek each task's receipts by the full key prefix; filtering by site alone walks every receipt of the site.
  const receipts = await db.prepare(`select r.task_id,r.completed_at from json_each(?) ids cross join team_status_receipts r
    on r.workspace_id=? and r.site_id=? and r.agent_id=json_extract(ids.value,'$[0]') and r.task_id=json_extract(ids.value,'$[1]')`)
    .bind(JSON.stringify(rows.map(row => [row.agent_id, row.id])), workspaceId, siteId).all<{ task_id: string; completed_at: string }>();
  const read = new Set(receipts.results.map(item => JSON.stringify([item.task_id, item.completed_at])));
  return Promise.all(rows.map(async (row, index) => {
    const goal = goals[index];
    let businessTitle = row.agent_id === 'content_production'
      ? groupNames.get(reference(goal.group_id)) || ''
      : jobNames.get(reference(goal.job_id)) || '';
    if (!businessTitle && row.assignment_id && ['article_production', 'content_review'].includes(row.agent_id)) {
      const assignment = await db.prepare('select context_json from agent_task_assignments where id=? and task_id=?')
        .bind(row.assignment_id, row.id).first<{ context_json: string }>();
      if (assignment) {
        const context = record(await readRuntimeJson(db, assignment.context_json));
        const topic = record(context.topic);
        businessTitle = titleText(topic.title_direction) || titleText(topic.title_hint) || titleText(topic.primary_keyword);
      }
    }
    const { goal_json: _goal, assignment_id: _assignment, ...task } = row;
    return { ...task, unread: row.status === 'completed' && (row.outcome !== 'unable_to_complete' || !!row.parent_task_id) && !read.has(JSON.stringify([row.id, row.updated_at])), display_title: taskTitle(row.agent_id, row, goal, businessTitle) };
  }));
}

/** A thin read for these two panels, not a second task or artifact abstraction. */
export async function readAgentPanel(scope: TeamScope, agentId: string, cursor = ''): Promise<AgentPanelList> {
  const { db, workspaceId, siteId } = scope;
  let before = ['', ''];
  if (cursor) {
    const parsed: unknown = JSON.parse(cursor);
    if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((v) => typeof v === 'string')) throw new Error('Invalid cursor');
    before = parsed;
  }
  const pending = await pendingWork(scope, agentId);
  const pendingIds = [...new Set(pending.map(item => item.task_id))];
  const pendingSql = pendingIds.length ? 'id in (select value from json_each(?))' : '0';
  const { results } = await db.prepare(`select ${titleColumns} from agent_tasks
    where workspace_id=? and site_id=? and agent_id=?
      and status in ('completed','cancelled') and not (${pendingSql})
      and (?='' or created_at < ? or (created_at=? and id < ?))
    order by created_at desc, id desc limit ?`)
    .bind(workspaceId, siteId, agentId, ...(pendingIds.length ? [JSON.stringify(pendingIds)] : []), before[0], before[0], before[0], before[1], pageSize + 1).all<TitleTask>();
  const history = results.slice(0, pageSize);
  // Unfinished tasks by status (index seek), plus finished tasks that still await a person, by id.
  const active = await db.prepare(`select ${titleColumns} from agent_tasks where workspace_id=? and site_id=? and agent_id=?
    and status in ('running','waiting','paused','failed')
    ${pendingIds.length ? `union select ${titleColumns.split(', ').map(c => `t.${c}`).join(', ')} from json_each(?) ids cross join agent_tasks t on t.id=ids.value
    where t.workspace_id=? and t.site_id=? and t.agent_id=?` : ''}`)
    .bind(workspaceId, siteId, agentId, ...(pendingIds.length ? [JSON.stringify(pendingIds), workspaceId, siteId, agentId] : [])).all<TitleTask>();
  // Sorted here: an ORDER BY in SQL lets the planner walk the site's updated_at index instead of seeking by status.
  active.results.sort((a, b) => a.updated_at !== b.updated_at ? (a.updated_at > b.updated_at ? -1 : 1) : a.id > b.id ? -1 : a.id < b.id ? 1 : 0);
  const tasks = (await titledTasks(scope, [...active.results, ...history])).map(task => ({ ...task,
    work_state: (pendingIds.includes(task.id) || !['completed','cancelled'].includes(task.status) ? 'current' : 'history') as 'current' | 'history',
    attention_count: pending.filter(item => item.task_id === task.id).length,
    unread: !!task.unread && !pendingIds.includes(task.id),
  }));
  const unread = await db.prepare(`select count(*) as count from agent_tasks t
    where t.workspace_id=? and t.site_id=? and t.agent_id=? and t.status='completed'
      and (t.outcome != 'unable_to_complete' or t.parent_task_id != '')
      and t.id not in (select value from json_each(?))
      and not exists (select 1 from team_status_receipts r where r.workspace_id=t.workspace_id and r.site_id=t.site_id
        and r.agent_id=t.agent_id and r.task_id=t.id and r.completed_at=t.updated_at)`)
    .bind(workspaceId, siteId, agentId, JSON.stringify(pendingIds)).first<{ count: number }>();
  const todos: PanelTodo[] = pending.map(item => ({ id: `${item.task_id}:${item.request_id}`, task_id: item.task_id, request_id: item.request_id, label: item.label, at: item.at }));
  const last = history.at(-1);
  return { tasks, todos, unread_history_count: Number(unread?.count ?? 0), next_cursor: results.length > pageSize && last ? JSON.stringify([last.created_at, last.id]) : null };
}

export async function readAgentPanelTask(scope: TeamScope, agentId: string, taskId: string, workCursor = ''): Promise<AgentPanelDetail | null> {
  const { db, workspaceId, siteId } = scope;
  const row = await db.prepare(`select ${titleColumns} from agent_tasks where workspace_id=? and site_id=? and agent_id=? and id=?`)
    .bind(workspaceId, siteId, agentId, taskId).first<TitleTask>();
  if (!row) return null;
  const run = await getAgentRun(db, row.active_run_id);
  if (!run || run.workspace_id !== workspaceId || run.site_id !== siteId || run.agent_id !== agentId) return null;
  const task = await taskForRun(db, run.id);
  if (!task || task.id !== taskId) return null;
  const [execution, draft, activity, children, goal, output, stream, interactions] = await Promise.all([
    taskExecutionView(db, task),
    readWorkingDraft(db, { workspaceId, siteId, agentId, instanceId: run.agent_instance_id, lineageId: run.root_run_id || run.id }),
    db.prepare(`select id, json_extract(action_json,'$.name') as name, status, error, created_at, updated_at
      from agent_task_operations where task_id=? and status != 'deciding' order by turn desc limit 50`)
      .bind(task.id).all<AgentPanelDetail['activity'][number]>(),
    // Unary + keeps the planner on the parent index instead of walking the site's tasks.
    db.prepare(`select ${columns} from agent_tasks where +workspace_id=? and +site_id=? and parent_task_id=? order by created_at desc`)
      .bind(workspaceId, siteId, task.id).all<PanelTask>(),
    readRuntimeJson(db, task.goal_json), readRuntimeJson(db, task.output_json),
    readWorkStream({ ...scope, task }, workCursor), workInteractions({ ...scope, task }),
  ]);
  let visibleGoal = goal;
  if (task.assignment_id && ['article_production', 'content_review'].includes(agentId)) {
    const assignment = await db.prepare('select context_json from agent_task_assignments where id=? and task_id=?')
      .bind(task.assignment_id, task.id).first<{ context_json: string }>();
    if (assignment) {
      const material = await readRuntimeJson<Record<string, unknown>>(db, assignment.context_json);
      visibleGoal = { topic: material.topic, group: material.group, source_locale: material.source_locale,
        locales: material.locales, editorial_brief: material.editorial_brief, coverage_plan: material.coverage_plan,
        parent_feedback: material.parent_feedback, evidence: material.evidence };
    }
  }
  let visibleDraft: AgentPanelDetail['draft'] = draft ? { content: draft.content, version: draft.version, status: draft.status, updatedAt: draft.updatedAt } : null;
  // These are existing domain storage shapes, read here solely for the classroom UI.
  if (agentId === 'strategy_research' || agentId === 'topic_decision') {
    const workspace = JSON.parse(task.workspace_json) as Record<string, unknown>;
    const content = agentId === 'strategy_research'
      ? { blueprint: workspace.blueprint, keywords: workspace.keywords }
      : { group: workspace.group, topics: workspace.topics };
    if (Object.values(content).some((value) => value != null)) visibleDraft = { content, version: task.revision, status: 'drafting', updatedAt: task.updated_at };
  }
  if (agentId === 'article_production') {
    const slot = await db.prepare(`select value_json from agent_parameter_slots where task_id=? and kind='article_draft' order by rowid desc limit 1`)
      .bind(task.id).first<{ value_json: string }>();
    if (slot) {
      const saved = await readRuntimeJson<{ assignment_id: string; bundle: unknown; editorial: unknown }>(db, slot.value_json);
      if (saved.assignment_id === task.assignment_id) visibleDraft = { content: { bundle: saved.bundle, evidence: saved.editorial }, version: task.revision, status: 'drafting', updatedAt: task.updated_at };
    }
    if (!visibleDraft) {
      const artifact = await db.prepare(`select a.versions_json, a.attempt, a.status, a.updated_at from content_artifacts a
        join content_production_groups g on g.id=a.group_id where a.child_run_id=? and +g.workspace_id=? and +g.site_id=? order by a.attempt desc limit 1`)
        .bind(run.id, workspaceId, siteId).first<{ versions_json: string; attempt: number; status: string; updated_at: string }>();
      if (artifact) visibleDraft = { content: await readRuntimeJson(db, artifact.versions_json), version: artifact.attempt, status: artifact.status, updatedAt: artifact.updated_at };
    }
  }
  const files: CabinetDocument[] = [];
  if (agentId === 'strategy_research') {
    // Pin the document to its owning Run, rather than the site's current strategy.
    const saved = await db.prepare(`select d.id, d.strategy_version_id, d.doc_type, d.body_md, d.created_at, v.source_locale, v.locale_version
      from seo_strategy_documents d join seo_strategy_versions v on v.id=d.strategy_version_id
      where +v.site_id=? and v.run_id=? and v.status!='draft' order by v.locale_version desc, d.doc_type`)
      .bind(siteId, run.id).all<{ id: string; strategy_version_id: string; doc_type: string; body_md: string; created_at: string; source_locale: string; locale_version: number }>();
    for (const versionId of new Set(saved.results.map(doc => doc.strategy_version_id))) {
      const strategy = saved.results.find(doc => doc.strategy_version_id === versionId && doc.doc_type === 'strategy');
      const notes = saved.results.find(doc => doc.strategy_version_id === versionId && doc.doc_type === 'research_notes');
      const doc = strategy || notes;
      const body = strategyDocumentBody(strategy?.body_md ?? '', notes?.body_md ?? '');
      if (doc && body) files.push({ id: strategy?.id || `${versionId}:strategy`, title: 'SEO strategy', category: 'Strategy documents',
        locale: doc.source_locale, version: doc.locale_version, body, date: doc.created_at });
    }
  }
  if (agentId === 'article_production') {
    const saved = await db.prepare(`select a.id, a.versions_json, a.attempt, a.updated_at from content_artifacts a
      join content_production_groups g on g.id=a.group_id where a.child_run_id=? and +g.workspace_id=? and +g.site_id=?
      and a.status in ('candidate','accepted') order by a.attempt desc`)
      .bind(run.id, workspaceId, siteId).all<{ id: string; versions_json: string; attempt: number; updated_at: string }>();
    for (const artifact of saved.results) {
      const versions = await readRuntimeJson<Array<{ locale: string; title: string; content: string }>>(db, artifact.versions_json);
      for (const version of versions) if (version.content?.trim()) files.push({ id: `${artifact.id}:${version.locale}`, title: version.title,
        category: 'Articles', locale: version.locale, version: artifact.attempt, body: version.content, date: artifact.updated_at });
    }
  }
  if (agentId === 'deep_research' && output && typeof output === 'object' && 'report' in output && typeof output.report === 'string' && output.report.trim()) {
    files.push({ id: `${task.id}:report`, title: 'Topic research report', category: 'Research materials', locale: '', version: 1, body: output.report, date: task.updated_at });
  }
  // Children expose only task receipts. Neither model messages nor private reasoning are read.
  return redactRuntimeValuePreservingSize({
    work: { ...stream, nodes: [...stream.nodes, ...interactions].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)) },
    task: { ...(await titledTasks(scope, [row]))[0], work_state: (interactions.some(node => node.interaction?.state === 'pending') || !['completed','cancelled'].includes(task.status)) ? 'current' : 'history', attention_count: interactions.filter(node => node.interaction?.state === 'pending').length, status: task.status, outcome: task.outcome, reason: task.reason, updated_at: task.updated_at },
    goal: visibleGoal, output, draft: visibleDraft, files,
    execution, activity: activity.results, children: children.results,
    usage: { input_tokens: run.input_tokens, output_tokens: run.output_tokens, cost_usd: run.cost_usd, started_at: run.started_at, finished_at: run.finished_at },
  }) as AgentPanelDetail;
}
