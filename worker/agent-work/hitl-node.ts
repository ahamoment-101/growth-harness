import { parseHitlSpec } from '../../shared/hitl';
import type { WorkNode } from '../../shared/agent-work';

/** Pure projection from an Agent-composed spec to a persisted work request. */
export function hitlWorkNode(requestId: string, at: string, input: unknown): WorkNode {
  const spec = parseHitlSpec(input);
  const maxResponseLength = spec.blocks.reduce((total, block) => total + ('max_length' in block ? block.max_length : block.type === 'choice' ? 100 : 0), 0);
  if (maxResponseLength > 16_000) throw new Error('HITL response capacity exceeds the task input limit');
  return {
    id: requestId, at, title: spec.title, state: 'attention',
    interaction: {
      id: requestId, version: '1', state: 'pending', spec,
      fields: spec.blocks.flatMap(block => {
        if (!('id' in block)) return [];
        return [{ id: block.id, label: block.label, kind: block.type === 'choice' ? 'select' as const : block.type === 'textarea' ? 'textarea' as const : 'text' as const,
          ...('options' in block ? { options: block.options.map(option => ({ value: option.value, label: option.label })) } : {}),
          ...('max_length' in block ? { max_length: block.max_length } : {}) }];
      }),
      actions: spec.actions.map(action => ({ id: action.id, label: action.label, required_fields: [], tone: action.tone === 'danger' ? 'danger' as const : 'primary' as const })),
    },
  };
}
