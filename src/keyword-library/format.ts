import type { KeywordCountryMetrics, KeywordSearchData, LibraryLanguage } from '../../shared/keyword-library';

/** Provider numbers older than this are shown as possibly out of date. */
const STALE_DAYS = 90;

export type DataStatus =
  | { kind: 'not_checked' }
  | { kind: 'no_data'; observed_at: string }
  | { kind: 'measured'; observed_at: string; stale: boolean };

/** Never checked, checked without provider data, and measured are different facts; unknown is not zero. */
export function dataStatus(data?: KeywordSearchData | null): DataStatus {
  const rows = data?.metrics || [];
  if (!rows.length) return { kind: 'not_checked' };
  const observed_at = rows.map(r => r.observed_at).sort().at(-1)!;
  if (rows.every(r => r.search_volume === null)) return { kind: 'no_data', observed_at };
  return { kind: 'measured', observed_at, stale: Date.now() - Date.parse(observed_at) > STALE_DAYS * 86_400_000 };
}

/** The country row the table shows: the largest measured one, else the first checked. */
export function primaryMetrics(data?: KeywordSearchData | null): KeywordCountryMetrics | null {
  const rows = data?.metrics || [];
  return [...rows].sort((a, b) => (b.search_volume ?? -1) - (a.search_volume ?? -1))[0] || null;
}

export function peakVolume(data?: KeywordSearchData | null) {
  return primaryMetrics(data)?.search_volume ?? null;
}

export const formatNumber = (value: number) => value.toLocaleString('en-US');

export function formatCpc(value: number | null) {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}

export function difficultyBand(value: number | null): { label: string; tone: 'ok' | 'warn' | 'bad' } | null {
  if (value === null) return null;
  if (value < 30) return { label: 'Easy', tone: 'ok' };
  if (value < 60) return { label: 'Medium', tone: 'warn' };
  return { label: 'Hard', tone: 'bad' };
}

/** Priority is Agent-written text in the language's language; only the tone of known words is inferred for display. */
export function priorityTone(value: unknown): 'high' | 'mid' | 'low' | '' {
  const v = String(value || '').trim().toLowerCase();
  if (['high', 'alta', 'alto', '\u9ad8', 'haute', 'hoch'].includes(v)) return 'high';
  if (['medium', 'média', 'media', 'médio', '\u4e2d', 'moyenne', 'mittel'].includes(v)) return 'mid';
  if (['low', 'baixa', 'baixo', '\u4f4e', 'basse', 'niedrig'].includes(v)) return 'low';
  return '';
}

const INTENTS: Record<string, string> = { informational: 'Informational', commercial: 'Commercial investigation', transactional: 'Transactional', navigational: 'Navigational' };
export const intentLabel = (value: string | null) => value ? INTENTS[value] || value : '—';

const FEATURES: Record<string, string> = {
  ai_overview: 'AI Overview', featured_snippet: 'Featured snippet', people_also_ask: 'Related questions', video: 'Videos', images: 'Images',
  local_pack: 'Local businesses', top_stories: 'Top news', shopping: 'Shopping',
};
export const featureLabel = (value: string) => FEATURES[value] || value;

export function countryName(code: string) {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) || code; } catch { return code; }
}

export function languageLabel(m: LibraryLanguage) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(m.locale) || m.locale; }
  catch { return m.locale; }
}

export function shortDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const md = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return date.getFullYear() === new Date().getFullYear() ? md : `${date.getFullYear()}-${md}`;
}

export function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.join(' · ') || 'Not recorded';
  return JSON.stringify(value);
}

export const FIELD_LABELS: Record<string, string> = {
  name: 'Name', intents: 'Search intent', stages: 'User stage', audiences: 'Target audience', scenarios: 'Use case', business_relevance: 'Business relationship',
  priority: 'Priority', priority_reason: 'Priority rationale', suggested_formats: 'Suggested format', uncertainties: 'Uncertainty', evidence: 'Research evidence',
  metrics: 'Metrics', archived: 'Archive status', description: 'Description', need: 'Core need', rationale: 'Grouping rationale', relationship: 'Relation notes',
  parent_id: 'Parent object', child_id: 'Member object', topic_id: 'Topic citations', present: 'Relation exists',
};
export const ACTION_LABELS: Record<string, string> = {
  create_keyword: 'Add keyword', update_keyword: 'Modify keyword', create_cluster: 'Add keyword cluster', update_cluster: 'Modify keyword cluster',
  create_topic_group: 'Add topic group', update_topic_group: 'Modify topic group', add_membership: 'Add member', remove_membership: 'Remove member',
  link_topic: 'Linked topics', unlink_topic: 'Unlink topic association',
};
