export type LibraryLanguage = { locale: string };
export type LibraryEntry = {
  id: string; kind: 'keyword' | 'topic_group' | 'cluster'; name: string;
  data: Record<string, unknown>; revision: number; archived: boolean;
  created_at: string; updated_at: string;
};
/**
 * Search data the host records from a keyword data provider, per country. It is
 * system-stamped (source, observation time) and never written by the model, so the
 * console can separate measured facts from the Agent's research judgment.
 * A row whose search_volume is null means the provider was asked and returned no data;
 * no row for a country means it was never checked.
 */
export type KeywordCountryMetrics = {
  country: string;
  search_volume: number | null;
  keyword_difficulty: number | null;
  intent: string | null;
  cpc_usd: number | null;
  monthly: Array<{ month: string; volume: number | null }>;
  source: string;
  observed_at: string;
};
export type KeywordSerpSnapshot = {
  country: string;
  features: string[];
  results: Array<{ rank: number; domain: string; url: string; title: string }>;
  source: string;
  observed_at: string;
};
export type KeywordSearchData = { metrics: KeywordCountryMetrics[]; serp: KeywordSerpSnapshot[] };
export type LibraryEntryView = LibraryEntry & {
  parents: Array<{ id: string; name: string; kind: string }>;
  topic_count: number; keyword_count: number;
  search_data?: KeywordSearchData | null;
};
export type LibraryPage = { items: LibraryEntryView[]; next: string | null };
export type LibraryDetail = {
  entry: LibraryEntry;
  memberships: Array<{ parent_id: string; child_id: string; parent_kind: string; child_kind: string }>;
  topics: Array<{ topic_id: string; title_hint: string; status: string; relationship: string }>;
  membership_next: { parent_id: string; child_id: string } | null;
  topic_next: string | null;
};
export type LibraryLog = {
  id: string; target_id: string; action: string; created_at: string; reason: string;
  actor: { type: 'human' | 'agent'; id: string; run_id?: string; task_id?: string };
  before: unknown; after: unknown;
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  receipt: { log_id: string; target_id: string; revision: number; changed: boolean };
};
export type LibraryLogPage = { items: LibraryLog[]; next: { created_at: string; id: string } | null };
export type LibraryTopic = {
  topic: { id: string; title_hint: string; status: string; category: string; primary_keyword: string; created_at: string };
  keywords: Array<{ id: string; name: string; relationship: string; search_data?: KeywordSearchData | null }>;
  next: string | null;
};
