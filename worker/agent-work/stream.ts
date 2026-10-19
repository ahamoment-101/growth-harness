import type { WorkNode, WorkStream } from '../../shared/agent-work';
import type { WorkRequestContext } from './contracts';

/** Action labels are display metadata, never inferred business outcomes. */
const labels: Record<string, string> = {
  read_topic_state: 'Review the current topic status', list_keyword_library_languages: 'View available language markets',
  open_keyword_library: 'View the keyword library', list_library_entries: 'Read keyword materials',
  read_topic_context: 'Understand the topic background', read_published_articles: 'View published articles',
  read_strategy: 'Read existing strategy', read_business_module: 'Understand the business background',
  search_web: 'Search for related materials', strategy_search_web: 'Search for market materials', article_search_web: 'Search for writing materials',
  read_web_page: 'Read sources', deep_research: 'Conduct in-depth research', read_evidence: 'Verify evidence',
  save_article_draft: 'Save article draft', submit_article: 'Submit article', run_self_check: 'Check article and citations',
  submit_strategy: 'Submit strategy deliverables', finish_strategy: 'End this round of research', submit_topic_decision: 'Submit topic results',
};
export const workActionLabel = (name: string) => labels[name] || 'Execute work step';

export async function readWorkStream({ db, task }: WorkRequestContext, cursor = ''): Promise<WorkStream> {
  let before = ['', ''];
  if (cursor) {
    const parsed: unknown = JSON.parse(cursor);
    if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every(value => typeof value === 'string')) throw new Error('Invalid work cursor');
    before = parsed;
  }
  // Notes have their own durable projection. Never read private reasoning or model transcripts here.
  // Each source is read newest first through its (task_id, created_at) index and stops at one page, so a
  // rebuild reads a page of rows however long the task has run. An operation older than a full page of
  // notes cannot be on this page, which bounds the operation scan even when most operations carry notes.
  type Row = { id: string; at: string; body: string; sequence: number; name: string; status: string; error: string };
  const notes = (await db.prepare(`select 'note:'||sequence as id,created_at as at,body,sequence,'' as name,'' as status,'' as error
    from agent_work_notes where task_id=? and (?='' or created_at<? or (created_at=? and 'note:'||sequence<?))
    order by created_at desc,id desc limit 41`).bind(task.id, before[0], before[0], before[0], before[1]).all<Row>()).results;
  const floor = notes.length === 41 ? notes[40].at : '';
  const operations = (await db.prepare(`select o.id,o.created_at as at,'' as body,0 as sequence,coalesce(json_extract(o.action_json,'$.name'),'') as name,o.status,o.error
    from agent_task_operations o where o.task_id=? and o.created_at>=? and o.status!='deciding'
      and (?='' or o.created_at<? or (o.created_at=? and o.id<?)) and not exists(
        select 1 from agent_conversation_calls c join agent_work_notes n on n.task_id=c.task_id and n.sequence=c.assistant_sequence
        where c.task_id=o.task_id and c.operation_id=o.id)
    order by o.created_at desc,o.id desc limit 41`).bind(task.id, floor, before[0], before[0], before[0], before[1]).all<Row>()).results;
  // Same order as SQL (binary string comparison), newest first.
  const newer = (a: Row, b: Row) => a.at !== b.at ? (a.at > b.at ? -1 : 1) : a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
  const rows = [...notes, ...operations].sort(newer).slice(0, 41);
  const page = rows.slice(0, 40);
  const sequences = page.filter(row => row.sequence).map(row => row.sequence);
  const records = sequences.length ? (await db.prepare(`select c.assistant_sequence,o.id,coalesce(json_extract(o.action_json,'$.name'),'') as name,o.status,o.error
    from agent_conversation_calls c join agent_task_operations o on o.id=c.operation_id and o.task_id=c.task_id
    where c.task_id=? and c.assistant_sequence in (${sequences.map(() => '?').join(',')}) order by o.turn`)
    .bind(task.id, ...sequences).all<{ assistant_sequence: number; id: string; name: string; status: string; error: string }>()).results : [];
  const nodes: WorkNode[] = page.reverse().map(row => {
    const operations = row.sequence ? records.filter(record => record.assistant_sequence === row.sequence) : [row];
    return { id: row.id, at: row.at, title: row.body ? 'Work progress' : workActionLabel(row.name), body: row.body || undefined,
      state: operations.some(record => ['running', 'ready'].includes(record.status)) ? 'working'
        : operations.some(record => ['failed', 'unknown'].includes(record.status)) ? 'failed' : 'recorded',
      records: operations.map(record => ({ id: record.id, label: record.name, status: record.status, error: record.error })),
    };
  });
  // The oldest item is first after reverse; cursor order is identical for both record sources.
  const last = page[0];
  return { nodes, next_cursor: rows.length > 40 && last ? JSON.stringify([last.at, last.id]) : null };
}
