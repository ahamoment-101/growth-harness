export function contentGroupTone(status: string) {
  if (status === 'awaiting_review') return 'ready';
  if (status === 'needs_attention') return 'bad';
  if (status === 'reviewing') return 'review';
  if (status === 'producing' || status === 'queued') return 'active';
  return 'idle';
}

export function contentGroupStatus(status: string) {
  const labels: Record<string, string> = {
    queued: 'Waiting to start',
    producing: 'Sub-Agent writing',
    reviewing: 'Parent Agent reviewing',
    needs_attention: 'Needs partial handling',
    awaiting_review: 'Pending pre-publish review',
  };
  return labels[status] || status;
}
