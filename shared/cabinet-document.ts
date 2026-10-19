/** Existing saved files as presented by the cabinet and Agent panels. */
export type CabinetDocument = { id: string; title: string; category: string; locale: string; version: number; body: string; date: string };
/** Both entry points compose the same version's saved strategy and evidence. */
export function strategyDocumentBody(strategy: string, researchNotes: string): string {
  return [strategy.trim(), researchNotes.trim() ? `## Research Basis and Sources

${researchNotes.trim()}` : ''].filter(Boolean).join('\n\n---\n\n');
}
