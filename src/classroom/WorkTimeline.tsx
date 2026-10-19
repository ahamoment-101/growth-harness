import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { WorkAction, WorkField, WorkInteraction, WorkNode, WorkResponse, WorkResponseReceipt } from '../../shared/agent-work';
import { MarkdownDocument } from '../components/MarkdownDocument';
import { formatDateTime } from '../api';
import { Link } from '../nav';
import { HitlView } from '../components/hitl/HitlView';
import type { HitlResponse } from '../../shared/hitl';

const recordStates: Record<string, string> = { succeeded: 'Completed', running: 'Executing', ready: 'Preparing to execute', failed: 'Incomplete', unknown: 'Result pending verification' };

function ComposedInteraction({ request, disabled, respond }: { request: WorkInteraction; disabled: boolean; respond: (input: WorkResponse) => Promise<WorkResponseReceipt> }) {
  const command = useRef<WorkResponse | null>(null);
  const [receipt, setReceipt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (request.state === 'resolved' || !request.spec) return null;
  async function send(response: HitlResponse) {
    if (busy || disabled) return;
    if (!command.current || JSON.stringify({ action: command.current.action, values: command.current.values }) !== JSON.stringify({ action: response.action, values: response.values })) {
      command.current = { ...response, command_id: crypto.randomUUID() };
    }
    setBusy(true); setError('');
    try { setReceipt((await respond(request.pending_submission || command.current)).message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Submission failed, please retry'); throw cause; }
    finally { setBusy(false); }
  }
  if (receipt) return <p role="status" className="aw-response">{receipt}</p>;
  if (request.pending_submission) return <div className="aw-interaction"><p>Response saved, continuing to verify the original operation.</p><button className="aw-button primary" disabled={busy || disabled} onClick={() => { void send(request.pending_submission!).catch(() => {}); }}>{busy ? 'Processing…' : 'Continue handling this response'}</button>{error && <p role="alert" className="ap-error">{error}</p>}</div>;
  return <HitlView request={{ id: request.id, version: request.version, spec: request.spec }} disabled={disabled} onRespond={send} />;
}

function ActionPopover({ action, anchor, busy, children, close }: { action: WorkAction; anchor: HTMLButtonElement; busy: boolean; children: React.ReactNode; close: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = panel.current!;
    element.showPopover();
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 32);
      element.style.width = `${width}px`;
      element.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
      const above = rect.top >= 240;
      element.style.top = above ? 'auto' : `${rect.bottom + 8}px`;
      element.style.bottom = above ? `${window.innerHeight - rect.top + 8}px` : 'auto';
      element.style.maxHeight = `${Math.max(100, (above ? rect.top : window.innerHeight - rect.bottom) - 24)}px`;
    };
    position();
    element.querySelector<HTMLElement>('textarea,input,select')?.focus();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); element.hidePopover(); };
  }, [anchor]);
  useLayoutEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!busy && !panel.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) { close(); anchor.focus(); } } };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape, true); };
  }, [anchor, busy, close]);
  return <div ref={panel} popover="manual" role="dialog" aria-label={`Confirm ${action.label}`} className="aw-action-popover"><strong>Confirm{action.label}</strong>{action.description && <p>{action.description}</p>}{children}</div>;
}

function Interaction({ request, disabled, respond, onOpenReview }: { request: WorkInteraction; disabled: boolean; respond: (input: WorkResponse) => Promise<WorkResponseReceipt>; onOpenReview?: (jobId: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>(request.pending_submission?.values || {});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState('');
  const [popup, setPopup] = useState<{ action: WorkAction; anchor: HTMLButtonElement } | null>(null);
  const command = useRef<WorkResponse | null>(null);
  const retry = request.pending_submission;
  const fieldPrefix = useId();
  const inlineFields = request.fields.filter(field => retry || !request.actions.some(action => action.input_mode === 'popover' && action.required_fields?.includes(field.id)) || request.actions.some(action => action.input_mode !== 'popover' && action.required_fields?.includes(field.id)));
  const close = () => { setPopup(null); setError(''); };
  async function submit(action: string) {
    if (busy || disabled) return;
    const selected = request.actions.find(item => item.id === action);
    if (!retry && selected?.required_fields?.some(id => !values[id]?.trim())) { setError('Please fill in the information required for this operation.'); return; }
    const submitted = Object.fromEntries(Object.entries(values).filter(([id]) => inlineFields.some(field => field.id === id) || selected?.required_fields?.includes(id)));
    const key = JSON.stringify({ action, values: submitted });
    if (!command.current || JSON.stringify({ action: command.current.action, values: command.current.values }) !== key) {
      command.current = { request_id: request.id, version: request.version, action, values: submitted, command_id: crypto.randomUUID() };
    }
    setBusy(true); setError('');
    try { const result = await respond(retry || command.current); setReceipt(result.message); setPopup(null); }
    catch (error) { setError(error instanceof Error ? error.message : 'Submission failed, please retry'); }
    finally { setBusy(false); }
  }
  const fields = (items: WorkField[]) => items.map(field => <label key={field.id}><span className="aw-field-heading"><span>{field.label}</span><small id={`${fieldPrefix}-${field.id}-hint`}>{request.actions.some(action => action.required_fields?.includes(field.id)) ? 'Required' : 'Optional'}</small></span>
    {field.kind === 'select' ? <select aria-describedby={`${fieldPrefix}-${field.id}-hint`} value={values[field.id] || ''} disabled={busy || disabled || !!retry} onChange={event => setValues(old => ({ ...old, [field.id]: event.target.value }))}><option value="">Please select</option>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      : field.kind === 'text' ? <input aria-describedby={`${fieldPrefix}-${field.id}-hint`} value={values[field.id] || ''} maxLength={field.max_length} disabled={busy || disabled || !!retry} onChange={event => setValues(old => ({ ...old, [field.id]: event.target.value }))} />
        : <textarea rows={3} aria-describedby={`${fieldPrefix}-${field.id}-hint`} placeholder={`Please enter ${field.label}…`} value={values[field.id] || ''} maxLength={field.max_length} disabled={busy || disabled || !!retry} onChange={event => setValues(old => ({ ...old, [field.id]: event.target.value }))} />}
  </label>);
  if (request.state === 'resolved') return request.response ? <div className="aw-response"><strong>{request.response.label}</strong><p>{request.response.note}</p><time>{formatDateTime(request.response.at)}</time></div> : null;
  if (receipt) return <p role="status" className="aw-response">{receipt}</p>;
  return <div className="aw-interaction">
    {fields(inlineFields)}
    {retry ? <><p>Response saved, continuing to verify and complete the original operation.</p><button className="aw-button primary" disabled={busy || disabled} onClick={() => void submit(retry.action)}>{busy ? 'Processing…' : 'Continue handling this response'}</button></>
      : <div className="aw-actions">{request.actions.map(action => action.href ? onOpenReview && /^\/website\/[^/]+\/review\/([^/]+)$/.test(action.href) ? <button key={action.id} className="aw-button" onClick={() => onOpenReview(decodeURIComponent(action.href!.split('/').at(-1)!))}>{action.label}</button> : <Link key={action.id} className="aw-button" to={action.href}>{action.label}</Link> : <div key={action.id}><button className={`aw-button ${action.tone || ''}`} disabled={busy || disabled} aria-haspopup={action.input_mode === 'popover' ? 'dialog' : undefined} aria-expanded={action.input_mode === 'popover' ? popup?.action.id === action.id : undefined} onClick={event => { if (action.input_mode === 'popover') { setError(''); setPopup(popup?.action.id === action.id ? null : { action, anchor: event.currentTarget }); } else void submit(action.id); }}>{busy ? 'Processing…' : action.label}</button>{action.description && action.input_mode !== 'popover' && <small>{action.description}</small>}</div>)}</div>}
    {popup && <ActionPopover action={popup.action} anchor={popup.anchor} busy={busy} close={close}>
      {fields(request.fields.filter(field => popup.action.required_fields?.includes(field.id)))}
      {error && <p className="ap-error" role="alert">{error}</p>}
      <div className="aw-popover-footer"><button className="aw-button" disabled={busy} onClick={() => { const anchor = popup.anchor; close(); anchor.focus(); }}>Cancel</button><button className="aw-button primary" disabled={busy || disabled} onClick={() => void submit(popup.action.id)}>{busy ? 'Processing…' : `Confirm ${popup.action.label}`}</button></div>
    </ActionPopover>}
    {error && !popup && <p className="ap-error" role="alert">{error}</p>}
  </div>;
}

export function WorkTimeline({ nodes, disabled, respond, onOpenReview }: { nodes: WorkNode[]; disabled: boolean; respond: (input: WorkResponse) => Promise<WorkResponseReceipt>; onOpenReview?: (jobId: string) => void }) {
  return <>{nodes.map(node => <li key={node.id} data-work-node={node.id} className={`aw-node ${node.state}${node.interaction?.state === 'pending' ? ' aw-needs-response' : ''}`}>
    <i /><div>
      <div className="aw-node-header"><div className="ap-event-heading">{!(node.interaction?.spec && node.interaction.state === 'pending') && <strong>{node.title}</strong>}{node.interaction?.state === 'pending' && <span>Waiting for your response</span>}{node.state === 'working' && <span>In progress</span>}{node.interaction?.state === 'resolved' && <span>Handled</span>}{node.state === 'failed' && <span>Execution hit a problem</span>}</div><time>{formatDateTime(node.at)}</time></div>
      {node.body && <MarkdownDocument markdown={node.body} />}
      {node.materials?.map((material, index) => <details className="aw-material" key={index}><summary>{material.title}</summary><MarkdownDocument markdown={material.markdown} /></details>)}
      {node.interaction && (node.interaction.spec
        ? <ComposedInteraction key={`${node.interaction.id}:${node.interaction.version}`} request={node.interaction} disabled={disabled} respond={respond} />
        : <Interaction key={`${node.interaction.id}:${node.interaction.version}`} request={node.interaction} disabled={disabled} respond={respond} onOpenReview={onOpenReview} />)}
      {!!node.records?.length && <details className="aw-records"><summary>View Execution log · {node.records.length}</summary>{node.records.map(record => <div key={record.id}><span>{record.label.replaceAll('_', ' ')} · {recordStates[record.status] || record.status}</span>{record.error && <p>{record.error === 'Call rejected or not executed' ? 'This step was not executed.' : record.error}</p>}</div>)}</details>}
    </div>
  </li>)}</>;
}
