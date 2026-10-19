import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type Site } from '../api';
import type { LeaderConversation, LeaderDetail, LeaderList, LeaderMessage } from '../../shared/growth-leader';
import { MarkdownDocument } from '../components/MarkdownDocument';
import { AgentPanels } from './AgentPanels';
import { WorkTimeline } from './WorkTimeline';
import { HitlHistoryCard } from '../components/hitl/HitlHistoryCard';
import { Portrait } from './avatars';
import { Icon } from './ui';
import { conversationPhase, conversationTitle, friendlyError, groupConversations, groupLeaderTasks, isClosed, mergeHistory, mergeLeaderFeed, relativeTime, reportVerb, taskPhase, titleFromMessage, type Phase } from './leader-view';
import { useRoomTopic } from '../site-room';
import './agent-panels.css';
import './leader-panel.css';

type Props = { site: Site; crowd: readonly string[]; names: Record<string, string>; missions: Record<string, string>; initialConversationId?: string; onClose: () => void; onSeen: (agentId: string, taskId: string, at: string) => Promise<void> };
type OpenTask = { id: string; agent_id: string; agent_name: string };
type View = { draft: string; scrollTop: number; follow: boolean };
const NEW = 'new';
const suggestions = ['Help me review the current content situation of the site. What should we do next?', 'Which language market is most worth prioritizing?', 'Which articles should we write this week?'];

function PhaseTag({ phase }: { phase: Phase }) {
  return <span className={`lp-phase ${phase.tone}`}>{phase.label}</span>;
}

export function LeaderPanel({ site, crowd, names, missions, initialConversationId, onClose, onSeen }: Props) {
  const siteId = site.id;
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string | null>(initialConversationId ?? null);
  const [detail, setDetail] = useState<LeaderDetail | null>(null);
  const [task, setTask] = useState<OpenTask | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const views = useRef(new Map<string, View>());
  const agentName = (t: { agent_id: string; agent_name?: string }) => names[t.agent_id] || t.agent_name || 'Team members';

  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => prior?.focus();
  }, []);

  // Conversations and delegated work are pushed by the site's live room.
  const liveList = useRoomTopic<LeaderList>(siteId, 'leader.list');
  const list = liveList.data ?? null;
  const listError = liveList.error ? 'The conversation list can\'t be read right now; retrying automatically…' : list && !liveList.connected ? 'Connection interrupted, reconnecting…' : '';

  // Land in the latest open conversation, or a fresh one when none is open.
  useEffect(() => {
    if (!list || selected) return;
    setSelected(groupConversations(list.conversations).open[0]?.id ?? NEW);
  }, [list, selected]);

  const onDetail = useCallback((value: LeaderDetail) => setDetail(value), []);

  function select(id: string) { setSelected(id); setTask(null); setDetail(null); }
  function openTask(t: { id: string; agent_id: string; agent_name?: string }) { setTask({ id: t.id, agent_id: t.agent_id, agent_name: agentName(t) }); }

  const conversations = list?.conversations ?? [];
  const { open, ended } = groupConversations(conversations);
  const endedVisible = showEnded || ended.some(c => c.id === selected);
  const current = selected && selected !== NEW ? (detail?.conversation.id === selected ? detail.conversation : conversations.find(c => c.id === selected)) : undefined;
  const currentDetail = detail?.conversation.id === selected ? detail : null;
  const titleOf = (id: string) => { const c = conversations.find(item => item.id === id); return c ? conversationTitle(c) : 'Another conversation'; };
  const railTasks = currentDetail?.tasks ?? [];
  const teamMembers = groupLeaderTasks(railTasks);
  const needsYou = railTasks.filter(t => t.attention_count > 0).length;

  const item = (c: LeaderConversation) => {
    const phase = conversationPhase(c);
    return <button key={c.id} className={`lp-conversation${selected === c.id ? ' selected' : ''}`} aria-current={selected === c.id} onClick={() => select(c.id)}>
      <strong>{conversationTitle(c)}</strong>
      <span><PhaseTag phase={phase} /><time dateTime={c.updated_at}>{relativeTime(c.updated_at)}</time></span>
    </button>;
  };

  return createPortal(<dialog ref={dialog} className="agent-panels leader-workspace" onCancel={onClose} aria-label="AI Growth Leader">
    <div className="ap-layout lp-layout">
      <aside className="ap-left lp-sidebar" aria-label="Conversations">
        <div className="lp-identity">
          <span className="lp-portrait"><Portrait id="cmo" crowd={crowd} /></span>
          <div><h1>AI Growth Leader</h1><p>Your growth lead: discuss direction, arrange the team, follow up on results</p></div>
        </div>
        <button className="lp-new" aria-pressed={selected === NEW} onClick={() => select(NEW)}>＋ New conversation</button>
        {listError && <p role="status" className="lp-note">{listError}</p>}
        <nav className="lp-conversations" aria-label="Conversation list">
          {!list && !listError && <p className="lp-note">Loading conversations…</p>}
          {!!open.length && <><h2>In progress</h2>{open.map(item)}</>}
          {list && !open.length && <p className="lp-note">No conversations in progress.</p>}
          {!!ended.length && <>
            <button className="lp-group-toggle" aria-expanded={endedVisible} onClick={() => setShowEnded(!endedVisible)}>Ended · {ended.length}<span aria-hidden="true">{endedVisible ? 'Collapse' : 'Expand'}</span></button>
            {endedVisible && ended.map(item)}
          </>}
        </nav>
      </aside>

      <section className="ap-right lp-main" aria-label="Converse with the Leader">
        {selected === NEW || !selected
          ? <LeaderChat key={NEW} siteId={siteId} id={null} view={views.current} crowd={crowd} onClose={onClose} onCreated={select} onDetail={onDetail} onOpenTask={openTask} onOpenConversation={select} titleOf={titleOf} agentName={agentName} ready={!!selected} />
          : <LeaderChat key={selected} siteId={siteId} id={selected} view={views.current} crowd={crowd} conversation={current} detail={currentDetail} onClose={onClose} onCreated={select} onDetail={onDetail} onOpenTask={openTask} onOpenConversation={select} titleOf={titleOf} agentName={agentName} ready />}
      </section>

      <aside className="ap-left lp-rail" aria-label="Team work">
        <header>
          <h2>Team work{needsYou > 0 && <span className="lp-count" title="Needs your confirmation">{needsYou}</span>}</h2>
        </header>
        <div className="lp-tasks">
          {teamMembers.length ? teamMembers.map(member => <section key={member.agent_id} className="lp-member">
            <span className="lp-task-head">
              <span className="lp-task-agent">
                <span className="lp-task-avatar"><Portrait id={member.agent_id} crowd={crowd} /></span>
                <span className="lp-task-agent-label"><b>{agentName(member.tasks[0])}</b></span>
              </span>
              <span className="lp-member-count">{member.tasks.length}  tasks</span>
            </span>
            <div className="lp-member-tasks">{member.tasks.map(t => <button key={t.id} className={`lp-task${task?.id === t.id ? ' selected' : ''}`} aria-current={task?.id === t.id} onClick={() => openTask(t)}>
              <span className="lp-task-summary"><strong>{t.display_title || t.goal || `Tasks for ${agentName(t)}`}</strong><PhaseTag phase={taskPhase(t)} /></span>
              <time dateTime={t.updated_at}>{relativeTime(t.updated_at)}</time>
            </button>)}</div>
          </section>)
            : <p className="lp-note">{selected === NEW ? 'After the conversation starts, the work the Leader arranges for it will appear here.'
              : currentDetail ? 'The Leader hasn\'t arranged team work for this conversation yet. When needed, it will assign tasks to the appropriate members, and progress will be shown here.' : 'Loading…'}</p>}
        </div>
      </aside>
    </div>
    {/* A team task opens that member's full detail over the Leader, on the chosen task. */}
    {task && <AgentPanels key={`${task.agent_id}:${task.id}`} site={site} siteId={siteId} agent={{ id: task.agent_id, name: task.agent_name, mission: missions[task.agent_id] || '' }} crowd={crowd} names={names} initialTaskId={task.id} onSeen={onSeen} onClose={() => setTask(null)} />}
  </dialog>, document.body);
}

type ChatProps = {
  siteId: string; id: string | null; view: Map<string, View>; crowd: readonly string[]; ready: boolean;
  conversation?: LeaderConversation; detail?: LeaderDetail | null;
  onClose: () => void; onCreated: (id: string) => void; onDetail: (detail: LeaderDetail) => void;
  onOpenTask: (task: { id: string; agent_id: string; agent_name?: string }) => void; onOpenConversation: (id: string) => void;
  titleOf: (id: string) => string; agentName: (task: { agent_id: string; agent_name?: string }) => string;
};

function LeaderChat({ siteId, id, view, crowd, ready, conversation, detail, onClose, onCreated, onDetail, onOpenTask, onOpenConversation, titleOf, agentName }: ChatProps) {
  const key = id ?? NEW;
  if (!view.has(key)) view.set(key, { draft: '', scrollTop: 0, follow: true });
  const saved = view.get(key)!;
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(saved.follow);
  const lastMessage = useRef<string | undefined>(undefined);
  const [draft, setDraftState] = useState(saved.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hasNew, setHasNew] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const pending = useRef<{ id: string; text: string } | null>(null);
  const creation = useRef<{ id: string; title: string; created: boolean } | null>(null);
  const command = useRef<{ key: string; id: string } | null>(null);
  const setDraft = (value: string) => { setDraftState(value); saved.draft = value; };
  const [history, setHistory] = useState<LeaderMessage[] | null>(null);

  // The recent part of the conversation is pushed live; nothing polls.
  const live = useRoomTopic<LeaderDetail>(siteId, id ? `leader.conv:${id}` : null);
  useEffect(() => { if (live.data) onDetail(live.data); }, [live.data, onDetail]);
  const loadError = live.error === 'not_found' ? 'This conversation can\'t be found.' : live.error ? 'The conversation can\'t be read right now; retrying automatically…' : '';
  async function showEarlier() {
    if (!id || !detail) return;
    try {
      const full = await api.leaderConversation(siteId, id);
      setHistory(full.messages);
    } catch (e) { setError(friendlyError(e, 'Earlier conversations can\'t be read right now; please try again later.')); }
  }

  const messages = detail?.messages ?? [];
  const feedItems = mergeLeaderFeed(mergeHistory(history, messages), detail?.hitl_requests ?? []);
  const lastItem = feedItems.at(-1);
  const latest = lastItem ? `${lastItem.kind}:${lastItem.value.id}` : undefined;
  useLayoutEffect(() => {
    const el = feed.current;
    if (!el || !detail) return;
    if (lastMessage.current === undefined) {
      el.scrollTop = follow.current ? el.scrollHeight : saved.scrollTop;
    } else if (latest !== lastMessage.current) {
      if (follow.current) el.scrollTop = el.scrollHeight; else setHasNew(true);
    }
    lastMessage.current = latest;
  }, [latest, detail, saved]);
  useEffect(() => { if (ready) input.current?.focus(); }, [ready, key]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  const status = conversation ?? detail?.conversation;
  const closed = !!status && isClosed(status);
  const paused = status?.status === 'paused';
  const thinking = !!status && !closed && !paused && (status.status === 'running' || status.pending_inputs > 0);
  const teamWorking = !!status && !closed && !thinking && status.team_active > 0;
  const tasks = new Map((detail?.tasks ?? []).map(t => [t.id, t]));

  async function send(text = draft.trim()) {
    if (!text || busy) return;
    setBusy(true); setError('');
    try {
      let target = id;
      if (!target) {
        creation.current ||= { id: crypto.randomUUID(), title: titleFromMessage(text), created: false };
        if (!creation.current.created) { await api.createLeaderConversation(siteId, creation.current); creation.current.created = true; }
        target = creation.current.id;
      }
      if (!pending.current || pending.current.text !== text) pending.current = { id: crypto.randomUUID(), text };
      await api.sendLeaderMessage(siteId, target, pending.current);
      pending.current = null; setDraft(''); follow.current = true; saved.follow = true;
      if (!id) { view.delete(NEW); creation.current = null; onCreated(target); return; }
    } catch (e) { setError(friendlyError(e, 'The message wasn\'t sent successfully, but the content has been preserved; you can try again.')); }
    finally { setBusy(false); }
  }
  async function control(action: 'resume' | 'cancel') {
    if (!id || busy) return;
    setBusy(true); setError(''); setConfirmEnd(false);
    const commandKey = `${id}:${action}`;
    if (command.current?.key !== commandKey) command.current = { key: commandKey, id: crypto.randomUUID() };
    try {
      await api.agentTaskCommand(siteId, 'growth_leader', id, action, '', command.current.id);
      command.current = null;
    } catch (e) { setError(friendlyError(e, action === 'cancel' ? 'Couldn\'t end the conversation; please try again later.' : 'Couldn\'t resume; please try again later.')); }
    finally { setBusy(false); }
  }

  function renderMessage(m: LeaderMessage) {
    const time = <time dateTime={m.created_at}>{relativeTime(m.created_at)}</time>;
    if (m.role === 'user') return <article key={m.id} className={`lp-msg user${m.pending ? ' pending' : ''}`}>
      <div className="lp-bubble">{m.text}</div>
      <footer>{m.pending ? <span>{thinking && status?.status === 'running' ? 'Delivered · The Leader will read it after finishing the current step' : 'Delivered · The Leader will read it shortly'}</span> : time}</footer>
    </article>;
    if (m.role === 'assistant') return <article key={m.id} className="lp-msg leader">
      <header><span className="lp-mini"><Portrait id="cmo" crowd={crowd} /></span><strong>Growth Leader</strong>{time}</header>
      <div className="lp-body"><MarkdownDocument markdown={m.text} /></div>
    </article>;
    if (m.role === 'assignment') return <article key={m.id} className="lp-card note">
      <small>{status?.source_id ? <>A request from the Leader, brought from "{titleOf(status.source_id)}"</> : 'Request brought by the Leader'}</small>
      <p>{m.text}</p>
    </article>;
    if (m.role === 'event') return <article key={m.id} className="lp-card note">
      <small>Automatic Tasks · {time}</small><p>{m.text}</p>
    </article>;
    const t = m.task_id ? tasks.get(m.task_id) : undefined;
    if (m.role === 'task') return <article key={m.id} className="lp-card task">
      <header><small className="lp-handoff-label">Leader handed the work to <span className="lp-handoff-agent">{t && <span className="lp-handoff-avatar"><Portrait id={t.agent_id} crowd={crowd} /></span>}<b>{t ? agentName(t) : 'Team members'}</b></span></small>{t && <PhaseTag phase={taskPhase(t)} />}</header>
      <strong>{t?.display_title || m.text || 'Team Task'}</strong>
      {t?.goal && !t.display_title.includes(t.goal) && <p>{t.goal}</p>}
      {t?.why && <p className="lp-why">Why:{t.why}</p>}
      {t && <button className="lp-link" onClick={() => onOpenTask(t)}>View progress and deliverables →</button>}
    </article>;
    return <article key={m.id} className="lp-card report">
      <header><small><b>{t ? agentName(t) : 'Team members'}</b> {reportVerb(t)}</small>{time}</header>
      {t && <strong>{t.display_title || t.goal}</strong>}
      <p>{m.summary || 'The deliverable has been handed to the Leader.'}</p>
      <footer>{m.pending && <span className="lp-muted">Leader is reading this report</span>}{t && <button className="lp-link" onClick={() => onOpenTask(t)}>View deliverable →</button>}</footer>
    </article>;
  }

  const title = id ? (status ? conversationTitle(status) : 'Loading…') : 'New Conversation';
  const empty = !id || (detail && !feedItems.length);

  function renderHitl(node: LeaderDetail['hitl_requests'][number]) {
    if (node.interaction?.state === 'pending') return <ul key={node.id} className="ap-timeline lp-hitl">
      <WorkTimeline nodes={[node]} disabled={busy} respond={response => api.respondToWork(siteId, 'growth_leader', id!, response)} />
    </ul>;
    return <div key={node.id} className="lp-hitl-archive"><HitlHistoryCard node={node} /></div>;
  }

  return <>
    <header className="ap-top lp-top">
      <div className="lp-heading">
        <strong title={title}>{title}</strong>
        <span>{status ? <PhaseTag phase={conversationPhase(status)} /> : !id && <span className="lp-muted">Share your thoughts and the Leader will arrange things accordingly</span>}
          {status?.source_id && <button className="lp-link" onClick={() => onOpenConversation(status.source_id)}>From “{titleOf(status.source_id)}”</button>}</span>
      </div>
      <div className="lp-actions">
        {id && status && !closed && status.status !== 'ready' && (confirmEnd
          ? <span className="lp-confirm">When it ends, the team work it arranged will also be canceled.<button disabled={busy} onClick={() => void control('cancel')}>Confirm End</button><button onClick={() => setConfirmEnd(false)}>Cancel</button></span>
          : <button className="lp-ghost" onClick={() => setConfirmEnd(true)}>End Conversation</button>)}
        <button className="icon-btn" onClick={onClose} aria-label="Close">{Icon.x}</button>
      </div>
    </header>
    <div className="lp-chat">
      <div ref={feed} className="lp-feed" aria-live="polite" onScroll={() => {
        const el = feed.current!;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        saved.scrollTop = el.scrollTop; saved.follow = follow.current;
        if (follow.current) setHasNew(false);
      }}>
        <div className="lp-thread">
          {status?.context && <details className="lp-context"><summary>Conversation Context</summary><p>{status.context}</p></details>}
          {id && !detail && !loadError && <p className="lp-note center">Loading conversations…</p>}
          {empty && (!id || detail) && <div className="lp-welcome">
            <span className="lp-portrait"><Portrait id="cmo" crowd={crowd} /></span>
            <h2>What would you like to discuss with the Leader?</h2>
            <p>Describe your business, ideas, or what you'd like the team to accomplish. The Leader will align with you first, then assign the right member to do it, and report the results back to you here.</p>
            {!closed && <div className="lp-suggestions">{suggestions.map(s => <button key={s} onClick={() => { setDraft(s); input.current?.focus(); }}>{s}</button>)}</div>}
          </div>}
          {detail?.has_earlier && !history && <button className="lp-link lp-earlier" onClick={() => void showEarlier()}>View earlier conversations</button>}
          {feedItems.map(item => item.kind === 'message' ? renderMessage(item.value) : renderHitl(item.value))}
          {thinking && <p className="lp-status active" role="status"><i /><i /><i />The Leader is thinking…</p>}
          {teamWorking && <p className="lp-status" role="status">The team is still working ({status!.team_active}  items). When there are results, the Leader will let you know here.</p>}
          {paused && <div className="lp-banner"><p><strong>This conversation is paused.</strong>{status?.reason && <> Reason:{status.reason}</>}</p><button disabled={busy} onClick={() => void control('resume')}>Resume</button></div>}
          {status?.status === 'failed' && <div className="lp-banner"><p><strong>This conversation was interrupted by an error.</strong>{status.reason && <> {status.reason}</>} You can start a new conversation to continue.</p></div>}
          {closed && status?.status !== 'failed' && <p className="lp-note center">This conversation has ended. You can start a new conversation to keep discussing.</p>}
        </div>
      </div>
      {hasNew && <button className="ap-new-work lp-jump" onClick={() => { const el = feed.current; if (el) el.scrollTop = el.scrollHeight; follow.current = true; saved.follow = true; setHasNew(false); }}>New message ↓</button>}
      {(error || loadError) && <p role="alert" className="lp-error">{error || loadError}</p>}
      {!closed && <form className="lp-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
        <textarea ref={input} aria-label="Talk with the Leader" value={draft} rows={1} disabled={paused || (!!id && !detail)}
          placeholder={paused ? 'Resume to continue the conversation' : 'Share your thoughts, or hand the team a task…'}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        <button disabled={!draft.trim() || busy || paused}>{busy ? 'Sending…' : 'Send'}</button>
        <small>Enter to send · Shift + Enter for a new line</small>
      </form>}
    </div>
  </>;
}
