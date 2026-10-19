import type { WorkNode } from '../../../shared/agent-work';
import { isVisible, type HitlBlock } from '../../../shared/hitl';
import { formatDateTime } from '../../api';
import './styles.css';

/** Read-only view of the original question and the saved human response. */
export function HitlHistoryCard({ node }: { node: WorkNode }) {
  const interaction = node.interaction;
  const spec = interaction?.spec;
  if (!interaction || !spec) return null;
  const response = interaction.response;
  const values = response?.values || {};
  const status = response?.outcome === 'superseded' ? 'Response not executed' : response ? 'Responded' : 'Ended';

  function renderBlock(block: HitlBlock, index: number) {
    if (!isVisible(block, values)) return null;
    if (block.type === 'text') return <p key={index} className="hitl-history__copy">{block.text}</p>;
    if (block.type === 'separator') return <hr key={index} />;
    if (block.type === 'notice') return <aside key={index} className="hitl-history__notice">{block.title && <strong>{block.title}</strong>}<p>{block.text}</p></aside>;
    if (block.type === 'reference') return <details key={index} className="hitl-history__reference"><summary>{block.label}</summary><p>{block.detail}</p></details>;
    const value = values[block.id];
    if (block.type === 'choice') return <div key={block.id} className="hitl-history__field"><strong>{block.label}</strong><ul>{block.options.map(option =>
      <li key={option.value} className={value === option.value ? 'selected' : ''}>
        <span>{value === option.value ? '✓ ' : ''}{option.label}</span>{option.description && <small>{option.description}</small>}
      </li>)}</ul></div>;
    return <div key={block.id} className="hitl-history__field"><strong>{block.label}</strong><p>{value || 'Not filled in'}</p></div>;
  }

  return <details className="hitl-history">
    <summary><span className="hitl-history__status">{status}</span><strong>{spec.title}</strong>
      <span className="hitl-history__answer">{response?.label || 'View original request'}</span><span className="hitl-history__toggle">View details</span></summary>
    <div className="hitl-history__detail">
      {spec.description && <p className="hitl-history__description">{spec.description}</p>}
      {spec.blocks.map(renderBlock)}
      <div className="hitl-history__actions"><strong>Action taken at the time</strong>{spec.actions.map(action =>
        <span key={action.id} className={response?.action === action.id ? 'selected' : ''}>{action.label}</span>)}</div>
      {response && <p className="hitl-history__receipt">{response.note} · <time dateTime={response.at}>{formatDateTime(response.at)}</time></p>}
      {!response && <p className="hitl-history__receipt">This request has ended with no executed response.</p>}
    </div>
  </details>;
}
