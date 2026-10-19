import { useRoomTopic } from '../site-room';
import { WorkTimeline } from './WorkTimeline';
import type { WorkNode, WorkResponse } from '../../shared/agent-work';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AgentPanelDetail, AgentPanelList } from '../../shared/agent-panel';
import type { AgentBubble } from '../../shared/team-status';
import { api, formatDateTime, type Site } from '../api';
import { Link } from '../nav';
import { MarkdownDocument } from '../components/MarkdownDocument';
import { Portrait } from './avatars';
import { Icon } from './ui';
import './agent-panels.css';
import { CabinetDocumentDetail, CabinetFileList } from './CabinetDocument';
import { panelDocuments, panelTaskTitle, panelWorkTitle, panelWorkContext } from './panel-content';
import { PublicationReview } from './PublicationReview';

type Props = {
  /** Opens the detail on this task, e.g. when the Leader's team-work rail links to it. */
  initialTaskId?: string;
  initialReviewJobId?: string;
  site?: Site; siteId: string; agent: { id: string; name: string; mission: string }; crowd: readonly string[];
  names: Record<string, string>; bubble?: AgentBubble; onClose: () => void;
  onSeen: (agentId: string, taskId: string, at: string) => Promise<void>;
};
const states: Record<string, string> = { running: 'Working', waiting: 'Waiting for next step', paused: 'Paused', completed: 'Ended', failed: 'Execution interrupted', cancelled: 'Cancelled', recovering: 'Resuming', succeeded: 'Completed', ready: 'Preparing to execute', unknown: 'Result pending verification' };
const labels: Record<string, string> = { topic: 'Topic Selection', topics: 'Topic Selection', group: 'Content Group', editorial_brief: 'Writing Requirements', coverage_plan: 'Content Coverage Plan', parent_feedback: 'Revision notes', blueprint: 'Strategy Blueprint', executive_strategy: 'Strategy Summary', roadmap: 'Implementation Plan', bundle: 'Draft', versions: 'Language Version', title: 'Title', title_direction: 'Title Direction', markdown: 'Body', body_markdown: 'Body', content: 'Content', summary: 'Summary', reason: 'Description', rationale: 'Rationale', goal: 'Goal', group_goal: 'Goal', locale: 'Language', source_locale: 'Source Language', query: 'Research Questions', question: 'Research Questions', evidence: 'Evidence', sources: 'Sources', url: 'Source Links', findings: 'Findings', recommendation: 'Suggestions', recommended_action: 'Suggested Next Steps', resume_when: 'Continuation Conditions', risks: 'Risks', unknowns: 'Pending Verification', blockers: 'Blockers', outcome: 'Results', status: 'Status', articles: 'Articles', locales: 'Language Version', territories: 'Market Direction', clusters: 'Topic', keywords: 'Keyword', output: 'Results', items: 'Items', notes: 'Notes' };

/** Business documents only; never renders model conversation or reasoning. */
function DocumentValue({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value == null || value === '' || (typeof value === 'object' && Object.keys(value).length === 0)) return <p className="ap-muted">No content yet</p>;
  if (typeof value === 'string') return <MarkdownDocument markdown={value} />;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  if (depth > 5) return <details><summary>Expand structured content</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
  if (Array.isArray(value)) return <div className="ap-document-list">{value.map((item, i) => <div key={i}><DocumentValue value={item} depth={depth + 1} /></div>)}</div>;
  return <div className="ap-document-fields">{Object.entries(value).map(([key, item]) => <section key={key}><h4>{labels[key] || key.replaceAll('_', ' ')}</h4><DocumentValue value={item} depth={depth + 1} /></section>)}</div>;
}
const taskTitle = panelTaskTitle;
const message = (error: unknown) => error instanceof Error ? error.message : 'Failed to load, please retry';

export function AgentPanels({ siteId, agent, crowd, names, onClose, onSeen, initialTaskId, initialReviewJobId }: Props) {
  const [list, setList] = useState<AgentPanelList | null>(null);
  const [taskId, setTaskId] = useState<string | null>(initialTaskId ?? null);
  const [detail, setDetail] = useState<AgentPanelDetail | null>(null);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [reviewJobId, setReviewJobId] = useState<string | null>(initialReviewJobId || null);
  const [seenError, setSeenError] = useState('');
  const [markingAll, setMarkingAll] = useState(false);
  const [olderNodes, setOlderNodes] = useState<WorkNode[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [focusRequest, setFocusRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [tab, setTab] = useState<'work' | 'history'>('work');
  const activeTab = useRef(tab);
  activeTab.current = tab;
  const [view, setView] = useState<'work' | 'products'>('work');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [hasNewWork, setHasNewWork] = useState(false);
  const workFeed = useRef<HTMLDivElement>(null);
  const followWork = useRef(true);
  const lastWorkRevision = useRef<string | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeTimer = useRef<number | null>(null);
  const paginated = useRef(false);
  const liveListSeen = useRef(false);
  const listSequence = useRef(0);
  const seen = useRef(new Set<string>());
  const command = useRef<{ key: string; id: string } | null>(null);
  const currentTask = useRef(taskId);
  currentTask.current = taskId;
  const hasRuntime = agent.id !== 'cmo';

  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); dialog.current?.close(); prior?.focus(); };
  }, []);

  function requestClose() {
    if (closing) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return; }
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, 280);
  }

  // The newest page of this member's tasks is pushed by the site room; older pages are read on demand.
  const liveList = useRoomTopic<AgentPanelList>(siteId, hasRuntime ? `panel:${agent.id}` : null);
  useEffect(() => {
    const result = liveList.data;
    if (!result) return;
    // A task opened from elsewhere that is already finished is listed under history.
    if (!liveListSeen.current && initialTaskId && result.tasks.find(task => task.id === initialTaskId)?.work_state === 'history') setTab('history');
    liveListSeen.current = true;
    setList(old => old ? { ...result, tasks: [...result.tasks, ...old.tasks.filter(task => task.work_state === 'history' && !result.tasks.some(next => next.id === task.id))], next_cursor: paginated.current ? old.next_cursor : result.next_cursor } : result);
    setTaskId(old => old || (activeTab.current === 'work' ? result.tasks.find(task => task.work_state === 'current')?.id ?? null : null));
  }, [liveList.data]);

  useEffect(() => {
    setDetail(null); setOlderNodes([]); setOlderCursor(undefined); setActionError(''); command.current = null;
    setView('work'); setDocumentId(null); setFileId(null); setHasNewWork(false); followWork.current = true; lastWorkRevision.current = undefined;
  }, [taskId]);

  // The task's latest work, drafts and files are pushed; earlier work nodes are read on demand.
  const liveDetail = useRoomTopic<AgentPanelDetail>(siteId, taskId ? `task:${agent.id}:${taskId}` : null);
  useEffect(() => {
    const result = liveDetail.data;
    if (!result || result.task.id !== currentTask.current) return;
    setDetail(old => old?.task.id === result.task.id ? { ...result, work: { ...result.work, next_cursor: old.work.next_cursor, nodes: [...old.work.nodes.filter(node => !node.interaction && !result.work.nodes.some(next => next.id === node.id)), ...result.work.nodes] } } : result);
  }, [liveDetail.data]);
  const detailError = liveDetail.error === 'not_found' ? 'Task not found' : liveDetail.error ? 'Latest progress is temporarily unavailable, auto-retrying' : '';
  const shownListError = listError || (liveList.error ? 'Task list is temporarily unavailable, auto-retrying' : '');

  useEffect(() => {
    if (!focusRequest || !detail || view !== 'work') return;
    const node = [...(workFeed.current?.querySelectorAll<HTMLElement>('[data-work-node]') || [])].find(item => item.dataset.workNode === focusRequest);
    if (node) { node.scrollIntoView({ block: 'start', behavior: 'smooth' }); followWork.current = false; setFocusRequest(''); }
  }, [detail, focusRequest, view]);

  useEffect(() => {
    if (!detail || !!detail.task.attention_count || document.visibilityState !== 'visible') return;
    const readable = (detail.task.status === 'completed' && (detail.task.outcome !== 'unable_to_complete' || !!detail.task.parent_task_id)) || (detail.task.status === 'waiting' && !!detail.task.parent_task_id && ['submitted', 'reviewed'].includes(detail.task.outcome));
    if (!readable) return;
    const { id, updated_at } = detail.task;
    const key = `${id}:${updated_at}`;
    if (seen.current.has(key)) return;
    seen.current.add(key);
    onSeen(agent.id, id, updated_at).then(() => {
      setSeenError('');
      setList(old => {
        if (!old) return old;
        const unread = old.tasks.some(task => task.id === id && task.updated_at === updated_at && task.work_state === 'history' && task.unread);
        return { ...old, unread_history_count: Math.max(0, old.unread_history_count - (unread ? 1 : 0)), tasks: old.tasks.map(task => task.id === id && task.updated_at === updated_at ? { ...task, unread: false } : task) };
      });
    }).catch(() => { seen.current.delete(key); setSeenError('Read status not yet synced, will retry automatically; to-dos will not be cleared.'); });
  }, [detail, agent.id, onSeen]);

  const workRevision = detail ? JSON.stringify([detail.task.work_state, detail.task.reason, detail.work.nodes]) : undefined;
  useEffect(() => {
    if (view !== 'work' || !workFeed.current) return;
    if (followWork.current) workFeed.current.scrollTop = workFeed.current.scrollHeight;
    else if (workRevision !== lastWorkRevision.current) setHasNewWork(true);
    lastWorkRevision.current = workRevision;
  }, [workRevision, view]);

  async function loadMore() {
    if (!list?.next_cursor || more) return;
    setMore(true);
    const request = ++listSequence.current;
    try {
      const result = await api.agentPanel(siteId, agent.id, list.next_cursor);
      if (request !== listSequence.current) return;
      paginated.current = true;
      setList(old => old ? { ...result, tasks: [...old.tasks.filter(task => !result.tasks.some(next => next.id === task.id)), ...result.tasks] } : result);
      setListError('');
    } catch (error) { setListError(message(error)); }
    finally { setMore(false); }
  }
  async function markAllHistoryRead() {
    if (markingAll) return;
    setMarkingAll(true); setSeenError('');
    try {
      await api.markAllTeamHistorySeen(siteId, agent.id);
      setList(old => old ? { ...old, unread_history_count: 0, tasks: old.tasks.map(task => task.work_state === 'history' ? { ...task, unread: false } : task) } : old);
    } catch (error) { setSeenError(`Failed to save mark-all-read: ${message(error)}`); }
    finally { setMarkingAll(false); }
  }
  async function execute(name: string) {
    if (!detail || busy) return;
    setBusy(true); setActionError('');
    const key = `${detail.task.id}:${name}`;
    if (command.current?.key !== key) command.current = { key, id: crypto.randomUUID() };
    try {
      await api.agentTaskCommand(siteId, agent.id, detail.task.active_run_id, name, '', command.current.id);
      command.current = null;
    } catch (error) { setActionError(message(error)); }
    finally { setBusy(false); }
  }
  const selected = detail?.task;
  const tasks = list?.tasks.filter(task => tab === 'history' ? task.work_state === 'history' : task.work_state !== 'history') ?? [];
  const nodes = [...olderNodes.filter(old => !detail?.work.nodes.some(node => node.id === old.id)), ...(detail?.work.nodes || [])].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  async function loadEarlier() {
    const cursor = olderCursor === undefined ? detail?.work.next_cursor : olderCursor;
    if (!taskId || !cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.agentPanelTask(siteId, agent.id, taskId, cursor);
      if (currentTask.current !== taskId) return;
      setOlderNodes(old => [...old.filter(node => !page.work.nodes.some(next => next.id === node.id)), ...page.work.nodes.filter(node => !node.interaction && !node.id.startsWith('response:'))]);
      setOlderCursor(page.work.next_cursor);
    } catch (error) { setActionError(message(error)); }
    finally { setLoadingOlder(false); }
  }
  async function respond(input: WorkResponse) {
    if (!taskId) throw new Error('No task selected yet');
    setBusy(true);
    // The room pushes the resulting state; the receipt answers the action itself.
    try { return await api.respondToWork(siteId, agent.id, taskId, input); }
    finally { setBusy(false); }
  }
  const files = detail?.files ?? [];
  const writing = !!detail && detail.task.status === 'running';
  const documents = detail && writing ? panelDocuments(detail) : [];
  const resolvedRequest = nodes.filter(node => node.interaction?.response || node.id.startsWith('response:')).at(-1);
  const workSummary = detail?.task.work_state === 'history' && resolvedRequest ? resolvedRequest.interaction?.response?.label || resolvedRequest.title : detail?.task.reason;
  const workContext = detail ? panelWorkContext(detail.goal) : [];
  const selectedFile = files.find(file => file.id === fileId);
  const productCount = files.length || documents.length;
  const activeDocument = documents.find(item => item.id === documentId) || documents[0];
  const panels = <>
      <aside className="ap-left">
        <div className="ap-identity"><span className="ap-portrait"><Portrait id={agent.id} crowd={crowd} /></span><div><h1>{agent.name}</h1><span className="ap-muted">{hasRuntime ? 'Work & Progress' : 'Execution service not connected yet'}</span></div></div>
        <p className="ap-mission">{agent.mission}</p>
        {shownListError && <p role="alert" className="ap-error">{shownListError}</p>}
        {!!list?.todos.length && <section className="ap-todos"><h2>Needs attention <span>{list.todos.length}</span></h2>{list.todos.map(todo => todo.task_id ? <button key={todo.id} disabled={busy} onClick={() => { setTaskId(todo.task_id!); setTab('work'); setView('work'); if (todo.request_id?.startsWith('publication:')) setReviewJobId(todo.request_id.slice('publication:'.length)); else { setReviewJobId(null); setFocusRequest(todo.request_id || ''); } }}><strong>{todo.label}</strong><span>Waiting for your response</span></button> : <Link key={todo.id} to={todo.href || '#'}><strong>{todo.label}</strong><span>View and handle ↗</span></Link>)}</section>}
        {hasRuntime && <><nav className="ap-tabs" aria-label="Task categories"><button aria-pressed={tab === 'work'} onClick={() => { setTab('work'); setTaskId(list?.tasks.find(task => task.work_state === 'current')?.id ?? null); }}>Current Tasks</button><button aria-pressed={tab === 'history'} onClick={() => { setTab('history'); setTaskId(null); }}>Historical Tasks{list?.tasks.some(task => task.work_state === 'history' && task.unread) && <span className="ap-unread-dot" role="img" aria-label="Unread tasks" />}</button></nav>
          {tab === 'history' && (list?.unread_history_count ?? 0) > 2 && <div className="ap-history-actions"><button type="button" onClick={() => void markAllHistoryRead()} disabled={markingAll}>{markingAll ? 'Marking…' : 'Mark all read'}</button></div>}
          <div className="ap-task-list">{!list && !shownListError ? <p className="ap-muted">Loading tasks…</p> : !tasks.length ? <p className="ap-muted">{tab === 'work' ? 'No tasks in progress right now' : 'No historical tasks in the loaded records'}</p> : tasks.map((task) => <button key={task.id} className={taskId === task.id ? 'selected' : ''} onClick={() => { if (!busy) setTaskId(task.id); }} disabled={busy} aria-pressed={taskId === task.id}><span className={`ap-state ${task.status}`}>{task.attention_count ? 'Needs your response' : states[task.status] || task.status}</span><strong>{task.work_state === 'history' && task.unread && <span className="ap-unread-dot" role="img" aria-label="Unread tasks" />}{taskTitle(task)}</strong><small>{task.work_state === 'history' ? 'View the work process and results' : task.reason || 'View task goals and latest progress'}</small><time>{formatDateTime(task.updated_at)}</time></button>)}</div>
          {list?.next_cursor && <button className="ap-more" onClick={loadMore} disabled={more}>{more ? 'Loading…' : 'Load more tasks'}</button>}</>}
      </aside>
      <section className="ap-right" aria-label="Real-time task progress">
        {reviewJobId ? <PublicationReview siteId={siteId} jobId={reviewJobId} onBack={() => setReviewJobId(null)} /> : <>
        <header className="ap-top ap-work-header">
          <nav className="ap-view-tabs" aria-label="Work view">
            <button aria-pressed={view === 'work'} onClick={() => setView('work')}>Agent work</button>
            <button aria-pressed={view === 'products'} onClick={() => setView('products')}>Artifacts{!!productCount && <span>{productCount}</span>}</button>
          </nav>
          <button autoFocus className="icon-btn" onClick={requestClose} aria-label="Close work details">{Icon.x}</button>
        </header>
        {seenError && <p role="status" className="ap-muted ap-notice">{seenError}</p>}
        {detailError && <p role="alert" className="ap-error ap-notice">{detailError}{detail ? '(showing the previous content first)' : ''}</p>}
        {!hasRuntime ? <div className="ap-empty"><h2>Team Lead</h2><p>Once the execution service is connected, real work activity and artifacts will appear here.</p></div> : !detail ? <div className="ap-empty"><h2>{taskId ? 'Loading work progress…' : tab === 'work' ? 'No tasks in progress right now' : 'Select a historical task'}</h2><p>{tab === 'work' ? 'After a task starts, the work process and results will be continuously updated here.' : 'View its work process and results.'}</p></div> : <>
          {view === 'work' && <div className="ap-work-title"><span className={`ap-state ${selected!.status}`}>{selected!.attention_count ? 'Needs your response' : states[detail.execution.execution_state] || detail.execution.execution_state}</span><h2>{panelWorkTitle(detail)}</h2><small>Updates in real time as work progresses</small></div>}
          <div className="ap-feed" ref={workFeed} hidden={view !== 'work'} onScroll={(event) => { const el = event.currentTarget; followWork.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (followWork.current) setHasNewWork(false); }}>
            <ol className="ap-work-stream" aria-label="Saved work activity">
              <li className="ap-stream-start"><i /><div><strong>Start work</strong>{workContext.map(item => <p key={item.label}>{item.label}: {item.text}</p>)}<time>{formatDateTime(selected!.created_at)}</time></div></li>
              {(olderCursor === undefined ? detail.work.next_cursor : olderCursor) && <li><i /><div><button className="ap-inline-link" disabled={loadingOlder} onClick={() => void loadEarlier()}>{loadingOlder ? 'Loading…' : 'Load earlier work records'}</button></div></li>}
              <WorkTimeline nodes={nodes} disabled={busy || !!detailError} respond={respond} onOpenReview={setReviewJobId} />
              <li className={`ap-stream-current ${selected!.status}`}><i /><div><strong>{selected!.attention_count ? 'Waiting for your response' : states[detail.execution.execution_state] || 'Work status'}</strong><p>{detail.execution.recovery_reason || workSummary}</p>{!!productCount && <button className="ap-inline-link" onClick={() => setView('products')}>View artifacts · {productCount} ↗</button>}
                {!!detail.children.length && <details className="ap-brief"><summary>Collaboration task · {detail.children.length}</summary>{detail.children.map(child => <div className="ap-child" key={child.id}><strong>{names[child.agent_id] || child.agent_id}</strong><span>{states[child.status] || child.status}</span><p>{child.reason || 'No return note yet'}</p></div>)}</details>}
                {(detail.execution.allowed_actions.includes('resume') || detail.execution.allowed_actions.includes('cancel')) && <details className="ap-brief"><summary>Task actions</summary>
                  {detail.execution.allowed_actions.includes('resume') && <button className="btn" disabled={busy || !!detailError} onClick={() => void execute('resume')}>Continue Task</button>}
                  {detail.execution.allowed_actions.includes('cancel') && <button className="btn" disabled={busy || !!detailError} onClick={() => void execute('cancel')}>Cancel Task</button>}
                </details>}
              </div></li>
            </ol>
            {actionError && <p role="alert" className="ap-error">{actionError}</p>}
          </div>
          {view === 'work' && hasNewWork && <button className="ap-new-work" onClick={() => { if (workFeed.current) workFeed.current.scrollTop = workFeed.current.scrollHeight; followWork.current = true; setHasNewWork(false); }}>New activity · View latest ↓</button>}
          <div className="ap-products" hidden={view !== 'products'}>
            <header className="ap-products-title"><span>Artifacts</span><h2>{selectedFile ? selectedFile.title : writing ? 'Writing' : 'File list'}</h2><p>{selectedFile ? 'Saved files' : writing ? 'The working draft updates as it is saved, and completed files are collected below.' : `${files.length} files · Click to view details`}</p></header>
            {selectedFile ? <><button className="room-back" onClick={() => setFileId(null)}>← Back to file list</button><CabinetDocumentDetail document={selectedFile} /></> : <>
              {writing && (documents.length ? <>
                {documents.length > 1 && <nav className="ap-product-list" aria-label="Working draft">{documents.map(item => <button key={item.id} aria-pressed={item.id === activeDocument?.id} onClick={() => setDocumentId(item.id)}><strong>{item.title}</strong><span>Working draft</span></button>)}</nav>}
                {activeDocument && <article className="ap-product-document" key={activeDocument.id}><header><div><span>Working draft</span><h3>{activeDocument.title}</h3></div><time>Recently saved {formatDateTime(activeDocument.at)}</time></header><DocumentValue value={activeDocument.content} /></article>}
              </> : <p className="room-empty">No saved working draft yet. Once saved, it will appear here.</p>)}
              {!!files.length && <section className="ap-saved-files">{writing && <h3>Completed files</h3>}<CabinetFileList documents={files} onOpen={setFileId} /></section>}
              {!writing && !files.length && <div className="ap-empty"><h2>This Task has no delivered files</h2><p>The Task conclusion is preserved in the end node of the Agent work.</p><button className="ap-inline-link" onClick={() => setView('work')}>View Agent work ↗</button></div>}
            </>}
          </div>
        </>}
        </>}
      </section>
  </>;
  return createPortal(<dialog ref={dialog} className={`agent-panels${closing ? ' closing' : ''}`} aria-label={`${agent.name} work details`} onCancel={(e) => { e.preventDefault(); e.stopPropagation(); requestClose(); }}>
    <div className="ap-layout">{panels}</div>
  </dialog>, document.body);
}
