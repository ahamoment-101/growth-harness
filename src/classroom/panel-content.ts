import type { AgentPanelDetail, PanelTask } from '../../shared/agent-panel';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Show the original purpose in the detail header, without the list title's truncation. */
export function panelWorkTitle(detail: AgentPanelDetail): string {
  const goal = record(detail.goal);
  for (const value of [goal.research_question, goal.goal, goal.question]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return panelTaskTitle(detail.task);
}

/** Only user-facing brief fields belong in the opening node; never dump runtime metadata. */
export function panelWorkContext(value: unknown): Array<{ label: string; text: string }> {
  const goal = record(value);
  const fields: Record<string, string> = { scope: 'Scope', constraints: 'Constraints', decision_use: 'Purpose', deliverable: 'Delivery Requirements', context: 'Background', directions: 'Research Directions' };
  return Object.entries(fields).flatMap(([key, label]) => {
    const item = goal[key];
    const text = typeof item === 'string' ? item.trim()
      : Array.isArray(item) ? item.filter((part): part is string => typeof part === 'string' && !!part.trim()).join('; ')
      : key === 'scope' ? [record(item).locale].filter(part => typeof part === 'string' && part).join(' / ') : '';
    return text ? [{ label, text }] : [];
  });
}
export function hasDocument(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return !!value.trim();
  if (typeof value === 'object') return Object.values(value).some(hasDocument);
  return true;
}
const documentNames: Record<string, string> = { blueprint: 'SEO Strategy', keywords: 'Keyword List', group: 'Content Plan', topics: 'Topic List', evidence: 'References', editorial: 'Editorial Notes' };
export function panelDocuments(detail: AgentPanelDetail) {
  const documents: Array<{ id: string; title: string; content: unknown; at: string; status: string }> = [];
  const add = (id: string, title: string, content: unknown, status: string, at: string) => {
    if (hasDocument(content)) documents.push({ id, title, content, status, at });
  };
  const draft = detail.draft;
  if (draft) {
    const content = record(draft.content);
    const versions = record(content.bundle).versions ?? content.versions;
    const status = detail.task.status === 'completed' && detail.task.outcome !== 'unable_to_complete' ? 'Completed' : 'Working draft';
    if (Array.isArray(versions)) {
      versions.forEach((value, i) => {
        const version = record(value);
        add(`draft:version:${String(version.locale ?? i)}`, String(version.title || version.locale || `Draft ${i + 1}`), value, status, draft.updatedAt);
      });
      add('draft:evidence', 'References', content.evidence, 'Saved', draft.updatedAt);
    } else if (Object.keys(content).some(key => key in documentNames)) {
      Object.entries(content).forEach(([key, value]) => add(`draft:${key}`, documentNames[key] || key, value, status, draft.updatedAt));
    } else add('draft', 'Working draft', draft.content, status, draft.updatedAt);
  }
  return documents;
}
export function panelTaskTitle(task: PanelTask) {
  if (task.display_title?.trim()) return task.display_title;
  const instance = task.agent_instance_id;
  if (task.agent_id === 'strategy_research' && instance.startsWith('strategy:')) {
    const locale = instance.slice('strategy:'.length);
    try { return `${new Intl.DisplayNames(['en'], { type: 'language' }).of(locale)} market · SEO Strategy`; } catch { return `${locale} market · SEO Strategy`; }
  }
  return ({ strategy_research: 'Research market and content strategy', deep_research: 'Topic deep research', keyword_research: 'Research search demand', content_production: 'Create content group', article_production: 'Write the article', content_review: 'Review the article', topic_decision: 'Plan content topics' } as Record<string, string>)[task.agent_id] || 'Work tasks';
}
