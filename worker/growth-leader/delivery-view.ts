type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Leader's coordination view; stored child output and artifact evidence remain untouched. */
export function leaderDeliveryView(report: RecordValue): RecordValue {
  if (report.agent !== 'content_production' || !record(report.result)) return report;
  const result = report.result;
  if (!record(result.state) || !Array.isArray(result.state.items)) return report;
  const items = result.state.items;
  const { state, ...memberReport } = result;
  const fields = ['job_id', 'decision_item_id', 'title_direction', 'job_status', 'artifact_id',
    'artifact_status', 'job_created_at', 'published_at', 'review_note', 'error'];
  return {
    ...report,
    result: {
      ...memberReport,
      group_observation: state.group,
      artifact_observations: items.map(item => record(item)
        ? Object.fromEntries(fields.filter(key => key in item).map(key => [key, item[key]])) : item),
      observation_meaning: 'These are the artifacts observed in the reported group. Their presence and review status do not attribute their creation to this delegation. Compare the requested change and assignment time with the reported work. Historical per-claim editorial reviews are omitted from this coordination view; use the article references when a publication decision requires the actual artifact.',
    },
  };
}
