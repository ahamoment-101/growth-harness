import { useEffect, useId, useState } from 'react';
import { Button, Input, Textarea } from './primitives';
import { createHitlResponse, isVisible, type HitlRequest, type HitlResponse, type HitlBlock } from '../../../shared/hitl';
import './styles.css';

export type HitlViewProps = {
  request: HitlRequest;
  onRespond: (response: HitlResponse) => Promise<void> | void;
  disabled?: boolean;
};

/** The host owns placement, visibility, dismissal and persistence. */
export function HitlView({ request, onRespond, disabled = false }: HitlViewProps) {
  const headingId = useId();
  const descriptionId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setValues({}); setError(''); }, [request.id, request.version]);

  const update = (id: string, value: string) => { setError(''); setValues(current => {
    const next = { ...current, [id]: value };
    // Hidden dependent inputs must never be submitted after their parent choice changes.
    for (const block of request.spec.blocks) if ('id' in block && !isVisible(block, next)) delete next[block.id];
    return next;
  }); };

  async function submit(action: string) {
    if (busy || disabled) return;
    try {
      const response = createHitlResponse(request, action, values);
      setBusy(true);
      setError('');
      await onRespond(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function renderBlock(block: HitlBlock, index: number) {
    if (!isVisible(block, values)) return null;
    if (block.type === 'text') return <p className="hitl-copy" key={index}>{block.text}</p>;
    if (block.type === 'separator') return <hr className="hitl-separator" key={index} />;
    if (block.type === 'notice') return <aside className={`hitl-notice hitl-notice--${block.tone}`} key={index}>{block.title && <strong>{block.title}</strong>}<p>{block.text}</p></aside>;
    if (block.type === 'reference') return <details className="hitl-reference" key={index}><summary>{block.label}</summary><p>{block.detail}</p></details>;
    const fieldId = `${headingId}-${block.id}`;
    if (block.type === 'choice') return <fieldset className="hitl-field" key={block.id}><legend>{block.label}{block.required && <span aria-hidden="true"> *</span>}</legend><div className="hitl-options">{block.options.map(option =>
      <label className={`hitl-option ${values[block.id] === option.value ? 'hitl-option--selected' : ''}`} key={option.value}>
        <input type="radio" name={fieldId} value={option.value} checked={values[block.id] === option.value} onChange={() => update(block.id, option.value)} disabled={busy || disabled} />
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
      </label>)}</div></fieldset>;
    return <label className="hitl-field" htmlFor={fieldId} key={block.id}><span>{block.label}{block.required && <span aria-hidden="true"> *</span>}</span>
      {block.type === 'textarea' ? <Textarea id={fieldId} rows={4} maxLength={block.max_length} value={values[block.id] || ''} placeholder={block.placeholder} disabled={busy || disabled} onChange={event => update(block.id, event.target.value)} />
        : <Input id={fieldId} maxLength={block.max_length} value={values[block.id] || ''} placeholder={block.placeholder} disabled={busy || disabled} onChange={event => update(block.id, event.target.value)} />}</label>;
  }

  return <section className="hitl-view" aria-labelledby={headingId} aria-describedby={request.spec.description ? descriptionId : undefined}>
    <header className="hitl-view__header"><p className="hitl-eyebrow">Your decision is needed</p><h2 id={headingId}>{request.spec.title}</h2>{request.spec.description && <p id={descriptionId}>{request.spec.description}</p>}</header>
    <div className="hitl-view__body">{request.spec.blocks.map(renderBlock)}</div>
    {error && <p className="hitl-error" role="alert">{error}</p>}
    <footer className="hitl-view__footer">{request.spec.actions.map(action => <Button key={action.id} variant={action.tone} disabled={busy || disabled} onClick={() => void submit(action.id)}>{busy ? 'Submitting…' : action.label}</Button>)}</footer>
  </section>;
}
