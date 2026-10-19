/** Domain-owned delivery view, not a summary of or replacement for the receipt. */
export function researchDeliveryView(output: unknown) {
  if (!output || typeof output !== 'object') throw new Error('Research delivery requires a complete saved result');
  const { report, sources, ...facts } = output as Record<string, unknown>;
  if (typeof report !== 'string' || !Array.isArray(sources) || typeof facts.task_id !== 'string') throw new Error('Research delivery requires a complete saved result');
  return {
    ...facts,
    research_task_id: facts.task_id,
    view_coverage: {
      report_included: false, findings_included: 'all', source_catalog_included: false,
      limitation: 'This is not the full report. Report prose may contain qualifications or limitations not repeated in the findings. The report and source access handles remain available.',
    },
    report_access: { tool: 'read_evidence', section: 'report', research_task_id: facts.task_id, offset: 0 },
    source_access: { tool: 'read_evidence', section: 'source', research_task_id: facts.task_id, source_id: '', offset: 0 },
    report_characters: report.length,
    source_count: sources.length,
  };
}
