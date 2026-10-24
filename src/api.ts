import type { LearningRecord, LearningDetail, LearningSection, LearningPage } from '../shared/learning';
import type { LeaderConversation, LeaderDetail, LeaderConfiguration } from '../shared/growth-leader';
import type { SiteLedgerResponse } from '../shared/site-ledger';
import type { AgentActivityPage } from '../shared/agent-activity';
import type { WorkResponse, WorkResponseReceipt } from '../shared/agent-work';
import type { AgentPanelList, AgentPanelDetail } from '../shared/agent-panel';
import type { LibraryLanguage, LibraryPage, LibraryDetail, LibraryLogPage, LibraryTopic } from '../shared/keyword-library';
import type { BusinessModuleContent, BusinessModuleKey } from '../shared/business';
import type { RosterMember } from '../shared/agent-roster';
import { redirectToLogin } from './auth-session';

export type WebhookField = { key: string; from: string; value?: string };

export type DailyTrigger = {
  site_id: string;
  enabled: number;
  task_mode: 'scheduled';
  action: 'start_topic_batch';
  local_time: string;
  timezone: 'Asia/Shanghai';
  next_due_at: string;
};

export type Site = {
  id: string;
  workspace_id: string;
  name: string;
  domain: string;
  root_domain: string;
  live_path: string;
    domain_status: 'unverified' | 'live' | 'error' | 'dns_ok' | string;
    domain_error: string;
    domain_checked_at: string;
    cname_target: string;
    probe_url: string;
  hosted_url: string;
  awaiting_review: number;
  published: number;
  queued_topics: number;
  ingest_url: string;
  secret_header: string;
  secret_set: boolean;
  source_locale: string;
  translate_locales: string[];
  locales: string[];
  webhook_fields: WebhookField[];
  hub_path: string;
  product_origin: string;
  hub_urls: Record<string, string>;
  locale_policy: {
    default_code: string;
    locales: Array<{ code: string; prefix: string }>;
    redirects: Array<{ fromPrefix: string; toPrefix: string }>;
  };
  seo_identity: {
    organizationName?: string;
    organizationUrl?: string;
    logoUrl?: string;
    defaultOgImage?: string;
    authorName?: string;
  };
  name_by_locale: Record<string, { value: string; deleted_at: string | null }>;
  blog_layout: string;
  publication_language_mode: 'all_enabled' | 'source_only';
  min_words: number;
  created_at: string;

  // Search Console placeholders (per site)
  gsc_oauth_status: string; // unconnected|connected
  gsc_google_account_email: string;
  gsc_property_url_prefix: string;
  gsc_property_verification_status: string; // unverified|verifying|verified
  gsc_property_verified_at: string;
  gsc_verification_meta_token: string;
  gsc_sitemap_submit_status: string;
  gsc_sitemap_last_submit_at: string;
};

export type Topic = {
  id: string;
  site_id: string;
  topic_key: string;
  title_hint: string;
  category: string;
  primary_keyword: string;
  status: string;
  created_at: string;
  decision_group_id?: string | null;
  decision_item_id?: string | null;
  plan_json?: string;
};

export type ArticleVersion = {
  meta_description?: string;
  image_url?: string;
  image_alt?: string;
  locale: string;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
};

export type Job = {
  id: string;
  site_id: string;
  topic_id: string | null;
  decision_group_id?: string | null;
  decision_item_id?: string | null;
  production_group_id?: string | null;
  current_artifact_id?: string | null;
  child_run_id?: string | null;
  plan?: Record<string, unknown>;
  status: string;
  visibility: 'visible' | 'hidden';
  translation_group: string | null;
  category: string | null;
  translate_locales?: string[];
  source_locale: string;
  versions: ArticleVersion[];
  title?: string | null;
  slug?: string | null;
  review_note: string | null;
  qa_report?: string | null;
  workflow_id: string | null;
  error: string | null;
  publish_response: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  /** Published articles only: site languages still to fill and localization runs in flight or failed. */
  localization?: JobLocalization;
};

export type JobLocalization = {
  missing_locales: string[];
  items: Array<{ locale: string; status: 'running' | 'failed'; error: string; updated_at: string }>;
};

export type QaReport = { ok: boolean; issues: Array<{ code: string; message: string }> };

export type ContentArtifactView = {
  id: string;
  group_id: string;
  child_run_id: string;
  attempt: number;
  status: string;
  supersedes_artifact_id: string;
  created_at: string;
  seo_contract: {
    search_intent?: string; reader_value?: string; direct_answer?: string; primary_keyword?: string;
    supporting_terms?: string[]; factual_claims?: Array<{ claim: string; evidence_ref: string }>; geo_summary?: string;
  };
  parent_review: {
    decision?: string; value_assessment?: string; seo_geo_risks?: string[]; required_changes?: string[];
  };
};

export type ContentReviewInteractionView = {
  id: string;
  group_id: string;
  job_id: string;
  artifact_id: string;
  parent_run_id: string;
  child_run_id: string;
  kind: string;
  actor_type: string;
  actor_id: string;
  summary: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type ResearchDocView = { body: string; created_at: string };

export type StrategyVersionView = {
  id: string;
  version: number;
  status: 'active' | 'superseded';
  change_summary: string;
  business_snapshot: Record<string, number>;
  research_scope: { summary?: string };
  source_locale: string;
  created_at: string;
};

export type ResearchState = {
  agent_name: string;
  locale: string;
  run: {
    id: string;
    trigger: string;
    status: 'running' | 'waiting' | 'ok' | 'failed' | 'cancelled';
    phase: string;
    outcome?: string;
    error: string;
    summary: unknown;
    started_at: string;
    finished_at: string;
  } | null;
  strategy: StrategyVersionView | null;
  documents: {
    strategy: ResearchDocView | null;
    keyword_map: ResearchDocView | null;
    research_notes: ResearchDocView | null;
  };
  versions: StrategyVersionView[];
  stats: {
    territories: number;
    clusters: number;
    /** Historical strategy keyword list; versions from definition v34 keep none. */
    keywords: number;
    sources: number;
    library_keywords: number;
  };
  runtime?: {
    run: AgentRunView;
    task?: { execution_state?: string; recovery_reason?: string; next_recovery_at?: string; allowed_actions?: string[]; current_action?: string; id: string; status: 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled'; outcome: string; reason: string; revision: number; next_turn: number; decision_turns: number; model_calls: number; reserved_tokens: number } | null;
    events: AgentEventView[];
    tool_calls: AgentToolCallView[];
    model_calls: AgentModelCallView[];
    approvals: AgentApprovalView[];
    child_runs: AgentChildRunView[];
    controls: { cancel: boolean; resume: boolean; approve: boolean; reject: boolean; provide_input: boolean };
    chat_enabled: boolean;
  } | null;
};

export type StrategyLocaleSummary = {
  locale: string;
  run: ResearchState['run'];
  strategy: StrategyVersionView | null;
  version_count: number;
};

export type AgentRunView = {
  output_json?: string;
  execution_outcome?: string;
  id: string;
  status: 'queued' | 'running' | 'waiting_for_approval' | 'waiting_for_input' | 'succeeded' | 'failed' | 'cancelled';
  phase: string;
  workflow_id: string;
  event_seq: number;
  error: string;
  started_at: string;
  finished_at: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

export type AgentEventView = {
  id: string;
  seq: number;
  kind: string;
  phase: string;
  actor_type: string;
  payload_json: string;
  created_at: string;
};

export type AgentToolCallView = {
  id: string; tool_call_key: string; tool_name: string; tool_version: number; capability: string;
  status: string; input_json: string; output_json: string; error: string; retryable: number;
  duration_ms: number; started_at: string; finished_at: string;
};

export type AgentModelCallView = {
  id: string; turn: number; provider: string; model: string; status: string; input_tokens: number;
  output_tokens: number; cost_usd: number; duration_ms: number; error: string; created_at: string;
  decision_turn?: number; attempt?: number; purpose?: string; actual_provider?: string;
  finish_reason?: string; text_tokens?: number; reasoning_tokens?: number; error_kind?: string; finished_at?: string;
};

export type AgentApprovalView = {
  id: string; tool_call_key: string; status: string; requested_json: string; decided_by: string;
  decision_note: string; requested_at: string; decided_at: string;
};

export type AgentChildRunView = {
  id: string; agent_id: string; status: AgentRunView['status']; phase: string; parent_run_id: string;
  root_run_id: string; error: string; created_at: string; finished_at: string;
};

export type TopicDecisionEvidence = {
  source_type: 'strategy' | 'business' | 'history' | 'performance' | 'web';
  ref: string;
  summary: string;
};

export type TopicDecisionItemView = {
  id: string; strategy_keyword_id: string; keyword_id: string; topic_key: string;
  title_direction: string; primary_keyword: string; content_type: string; locale: string;
  search_intent: string; group_role: string; rationale: string; hypothesis: string;
  evidence: TopicDecisionEvidence[]; relationship_to_existing: string; risk: string;
  sort_order: number; topic_id: string | null; job_id: string | null;
  strategy_version_id: string | null; strategy_version: number;
};

export type TopicDecisionResultView = {
  id: string; run_id: string; strategy_version_id: string | null; strategy_version: number; scope: LibraryLanguage;
  decision_type: 'topic_group' | 'needs_research'; status: 'draft' | 'rejected' | 'handed_off' | 'research_needed';
  group_goal: string; rationale: string; group_hypothesis: string; expected_signals: string[];
  risks: string[]; unknowns: string[]; previous_group_relationship: string;
  research_request: Record<string, unknown>; web_evidence: Array<Record<string, unknown>>;
  requested_count: number; locales: string[]; reviewed_by: string; review_note: string;
  reviewed_at: string; created_at: string; updated_at: string; items: TopicDecisionItemView[];
  language_decisions: Array<Record<string, unknown>>;
};

export type TopicDecisionDeferView = {
  reason: string;
  blockers: string[];
  recommended_action: string;
  resume_when: string;
};

export type TopicDecisionState = {
  task: {id:string;status:string;outcome:string;reason:string;execution_state:string;allowed_actions:string[]} | null;
  agent_name: string; agent_id: 'topic_decision'; latest_run: AgentRunView | null;
  runtime_agent_name: string;
  events: AgentEventView[]; tool_calls: AgentToolCallView[]; model_calls: AgentModelCallView[];
  results: TopicDecisionResultView[];
  latest_outcome: {
    decision?: 'topic_group' | 'needs_research' | 'defer';
    status?: 'draft' | 'research_needed' | 'deferred';
    rationale?: string;
    defer?: TopicDecisionDeferView;
  };
};

export type ContentProductionItemView = {
  group_id: string;
  job_id: string;
  job_status: string;
  review_note: string;
  current_artifact_id: string;
  decision_item_id: string;
  title_direction: string;
  primary_keyword: string;
  group_role: string;
  sort_order: number;
  artifact_id: string | null;
  attempt: number | null;
  artifact_status: string | null;
  parent_review: {
    decision?: 'pass' | 'revise';
    value_assessment?: string;
    seo_geo_risks?: string[];
    required_changes?: string[];
    seo_strategy_assessment?: string;
    topic_requirement_assessment?: string;
    author_self_check_assessment?: string;
    link_assessment?: string;
    link_findings?: Array<{ locale: string; anchor_text: string; target: string; problem: string; recommended_change: string }>;
  };
  child_run_id: string | null;
  child_run_status: AgentRunView['status'] | null;
  child_run_phase: string | null;
  child_run_error: string | null;
  child_run_output: { outcome?: string; reason?: string; action_turns?: number };
  /** Latest author operation, used to show self-check progress. */
  child_last_action: string | null;
  child_last_action_status: string | null;
  /** Present on the group detail payload only. */
  self_check?: { summary: string; findings: number; declined: number } | null;
  internal_link_counts?: Array<{ locale: string; internal_links: number }>;
  review_run_id: string | null;
  review_run_status: AgentRunView['status'] | null;
  review_run_phase: string | null;
  review_run_error: string | null;
  review_run_output: { outcome?: string; decision?: 'pass' | 'revise' | null; reason?: string; action_turns?: number };
  interactions?: ContentReviewInteractionView[];
  artifacts?: Array<{
    id: string;
    attempt: number;
    status: string;
    child_run_id: string;
    supersedes_artifact_id: string;
    created_at: string;
    updated_at: string;
    parent_review: ContentProductionItemView['parent_review'];
  }>;
};

export type ContentProductionGroupView = {
  id: string;
  workspace_id: string;
  site_id: string;
  decision_group_id: string;
  parent_run_id: string;
  status: 'queued' | 'producing' | 'reviewing' | 'needs_attention' | 'awaiting_review';
  total_items: number;
  ready_items: number;
  produced_items: number;
  active_items: number;
  failed_items: number;
  review_round: number;
  review: { group_summary?: string; items?: unknown[] };
  error: string;
  group_goal: string;
  group_hypothesis: string;
  parent_run_status: AgentRunView['status'] | null;
  parent_run_phase: string | null;
  parent_run_error: string | null;
  parent_run_started_at: string | null;
  parent_run_updated_at: string | null;
  parent_last_action: string | null;
  parent_last_action_status: string | null;
  latest_event_kind: string | null;
  latest_event_phase: string | null;
  latest_event_payload: Record<string, unknown>;
  latest_event_at: string | null;
  latest_model: string | null;
  latest_model_status: string | null;
  latest_model_error: string | null;
  model_attempts?: AgentModelCallView[];
  created_at: string;
  updated_at: string;
  items: ContentProductionItemView[];
};

export type BusinessModuleView = {
  key: BusinessModuleKey;
  content: BusinessModuleContent;
  markdown: string;
  version: number;
  schema_version: number;
  source: string;
  updated_at: string;
};

export type AuthState = {
  authenticated: boolean;
  required: boolean;
  methods?: Array<'password' | 'google'>;
  setup_required?: boolean;
  setup_available?: boolean;
  password_set?: boolean;
  google_linked?: boolean;
  user?: { id: string; email: string; name: string; picture: string };
  workspace?: { id: string; name: string };
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  let data: (T & { error?: string; code?: string }) | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as T & { error?: string };
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    // Rejected login credentials are a form error; protected requests signal an expired session.
    if (res.status === 401 && path !== '/api/auth/password/login') {
      redirectToLogin();
      throw new Error('Session expired, please log in again');
    }
    throw Object.assign(new Error(data?.error || res.statusText || `Request failed (${res.status})`), {
      code: typeof data?.code === 'string' ? data.code : '', status: res.status,
    });
  }
  if (!data) throw new Error('The server returned an unrecognized response');
  return data;
}

export const api = {
  learningRecords: (siteId: string, query = '', status = '', before = '') => req<{ records: LearningRecord[]; next_cursor: string | null }>(`/api/sites/${encodeURIComponent(siteId)}/learning/records?${new URLSearchParams({q:query,status,before})}`),
  learningPage: (siteId:string,id:string,section:LearningSection,after:string) => req<LearningPage>(`/api/sites/${encodeURIComponent(siteId)}/learning/records/${encodeURIComponent(id)}?${new URLSearchParams({section,after})}`),
  learningDetail: (siteId: string, id: string) => req<LearningDetail>(`/api/sites/${encodeURIComponent(siteId)}/learning/records/${encodeURIComponent(id)}`),
  taskLearning: (siteId: string, taskId: string) => req<{ formed: LearningRecord | null; used: Array<LearningRecord & { reason: string }> }>(`/api/sites/${encodeURIComponent(siteId)}/learning/tasks/${encodeURIComponent(taskId)}`),

  leaderConfiguration: (siteId: string) => req<LeaderConfiguration>(`/api/sites/${siteId}/leader/configuration`),
  startLeaderConversation: (siteId: string, input: { id: string; title: string; message: { id: string; text: string } }) => req<{ accepted: boolean; id: string }>(`/api/sites/${siteId}/leader/start`, { method: 'POST', body: JSON.stringify(input) }),
  createLeaderConversation: (siteId: string, input: { id: string; title: string }) => req<LeaderConversation>(`/api/sites/${siteId}/leader/conversations`, { method: 'POST', body: JSON.stringify(input) }),
  leaderConversation: (siteId: string, id: string) => req<LeaderDetail>(`/api/sites/${siteId}/leader/conversations/${encodeURIComponent(id)}`),
  sendLeaderMessage: (siteId: string, id: string, input: { id: string; text: string }) => req<{ accepted: boolean }>(`/api/sites/${siteId}/leader/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(input) }),
  siteLedger: (siteId: string) => req<SiteLedgerResponse>(`/api/sites/${siteId}/ledger`),
  agentActivity: (siteId: string, cursor = '', agentId = '') => req<AgentActivityPage>(`/api/sites/${siteId}/activity?${new URLSearchParams({ cursor, agent_id: agentId })}`),
  authState: () => req<AuthState>('/api/auth/me'),
  passwordLogin: (email: string, password: string) => req<{ ok: boolean }>('/api/auth/password/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  setupOwner: (email: string, password: string, setup_token: string) => req<{ ok: boolean }>('/api/auth/setup', { method: 'POST', body: JSON.stringify({ email, password, setup_token }) }),
  changePassword: (current_password: string, password: string) => req<{ ok: boolean }>('/api/auth/password', { method: 'POST', body: JSON.stringify({ current_password, password }) }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  sites: () => req<{ sites: Site[] }>('/api/sites'),
  site: (id: string) => req<{ site: Site }>(`/api/sites/${id}`),
  agentRoster: (siteId: string) => req<{ members: RosterMember[] }>(`/api/sites/${siteId}/agent-roster`),
  agentPanel: (siteId: string, agentId: string, cursor = '') => req<AgentPanelList>(`/api/sites/${siteId}/agent-panel/${encodeURIComponent(agentId)}?cursor=${encodeURIComponent(cursor)}`),
  agentPanelTask: (siteId: string, agentId: string, taskId: string, before = '') => req<AgentPanelDetail>(`/api/sites/${siteId}/agent-panel/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}?before=${encodeURIComponent(before)}`),
  respondToWork: (siteId: string, agentId: string, taskId: string, input: WorkResponse) => req<WorkResponseReceipt>(`/api/sites/${siteId}/agent-panel/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}/responses`, { method: 'POST', body: JSON.stringify(input) }),
  agentTaskCommand: (siteId: string, agentId: string, runId: string, command: string, value: string, commandId: string) => req<unknown>(`/api/sites/${siteId}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/commands`, { method: 'POST', body: JSON.stringify({ command, value, command_id: commandId }) }),
  markTeamSeen: (siteId: string, agentId: string, taskId: string, at: string) => req<{ ok: boolean }>(`/api/sites/${siteId}/team-status/${encodeURIComponent(agentId)}/seen`, { method: 'POST', body: JSON.stringify({ task_id: taskId, at }) }),
  markAllTeamHistorySeen: (siteId: string, agentId: string) => req<{ ok: boolean }>(`/api/sites/${siteId}/team-status/${encodeURIComponent(agentId)}/seen-all`, { method: 'POST' }),
  business: (siteId: string) => req<{ modules: BusinessModuleView[] }>(`/api/sites/${siteId}/business`),
  saveBusinessModule: (siteId: string, key: BusinessModuleKey, markdown: string, signal?: AbortSignal) =>
    req<{ module: BusinessModuleView }>(`/api/sites/${siteId}/business/${key}`, {
      method: 'POST',
      body: JSON.stringify({ markdown }),
      signal,
    }),
  createSite: (body: Record<string, unknown>) => req<{ site: Site }>('/api/sites', { method: 'POST', body: JSON.stringify(body) }),
  updateSite: (id: string, body: Record<string, unknown>) =>
    req<{ site: Site }>(`/api/sites/${id}`, { method: 'POST', body: JSON.stringify(body) }),
  dailyTrigger: (siteId: string) => req<{ trigger: DailyTrigger | null }>(`/api/sites/${siteId}/daily-trigger`),
  saveDailyTrigger: (siteId: string, body: { enabled: boolean; task_mode: 'scheduled'; action: 'start_topic_batch'; local_time: string }) =>
    req<{ trigger: DailyTrigger }>(`/api/sites/${siteId}/daily-trigger`, { method: 'PUT', body: JSON.stringify(body) }),
  translateSiteName: (id: string, body: { locale: string; name?: string }) =>
    req<{ locale: string; name: string }>(`/api/sites/${id}/translate-name`, { method: 'POST', body: JSON.stringify(body) }),
  gscStatus: (siteId: string) =>
    req<{
      gsc: {
        oauth_status: string;
        google_account_email: string;
        property_url_prefix: string;
        property_verification_status: string;
        property_verified_at: string;
        sitemap_submit_status: string;
        sitemap_last_submit_at: string;
      };
    }>(`/api/sites/${siteId}/gsc`),
  gscVerifyProperty: (siteId: string) => req<{ ok: boolean; site?: Site }>(`/api/sites/${siteId}/gsc/verify-property`, { method: 'POST' }),
  gscSubmitSitemap: (siteId: string) => req<{ ok: boolean; site?: Site }>(`/api/sites/${siteId}/gsc/submit-sitemap`, { method: 'POST' }),
  gscAnalytics: (siteId: string, params?: { start?: string; end?: string; dimension?: string; page?: number }) => {
    const qs = new URLSearchParams();
    if (params?.start) qs.set('start', params.start);
    if (params?.end) qs.set('end', params.end);
    if (params?.dimension) qs.set('dimension', params.dimension);
    if (params?.page) qs.set('page', String(params.page));
    const q = qs.toString();
    return req<{
      ok: boolean;
      startDate: string;
      endDate: string;
      dimension: string[];
      lastSyncDate: string | null;
      page: number;
      pageSize: number;
      rowCount: number;
      rows: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>;
      daily: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>;
    }>(`/api/sites/${siteId}/gsc/analytics${q ? '?' + q : ''}`);
  },
  gscSync: (siteId: string) =>
    req<{ ok: boolean; synced: number }>(`/api/sites/${siteId}/gsc/analytics`, { method: 'POST' }),
  research: (siteId: string, locale: string, version?: number) => {
    const qs = new URLSearchParams({ locale });
    if (version) qs.set('version', String(version));
    return req<ResearchState>(`/api/sites/${siteId}/research?${qs}`);
  },
  contentProductionGroup: (siteId: string, groupId: string) =>
    req<{ group: ContentProductionGroupView }>(`/api/sites/${siteId}/content-production/${groupId}`),
  testWebhook: (id: string) =>
    req<{ ok: boolean; status?: number; url?: string; body?: string; error?: string }>(`/api/sites/${id}/test`, { method: 'POST' }),
  checkHost: (id: string) =>
    req<{
      site: Site;
      check: {
        dns: { ok: boolean; message: string; cname: string[]; a?: string[]; aaaa?: string[]; target: string };
        live: { ok: boolean; message: string };
        status: string;
        probe_url: string;
      };
    }>(`/api/sites/${id}/check-host`, { method: 'POST' }),
  topics: (siteId: string) => req<{ topics: Topic[] }>(`/api/sites/${siteId}/topics`),
  createTopic: (siteId: string, body: Record<string, unknown>) =>
    req<{ topic: Topic }>(`/api/sites/${siteId}/topics`, { method: 'POST', body: JSON.stringify(body) }),
  seedPack: (siteId: string) => req<{ added: number }>(`/api/sites/${siteId}/seed-pack`, { method: 'POST' }),
  jobs: (siteId: string, status?: string) =>
    req<{ jobs: Job[] }>(`/api/sites/${siteId}/jobs${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  importJob: (
    siteId: string,
    body: ArticleVersion & { category?: string },
  ) => req<{ job: Job }>(`/api/sites/${siteId}/jobs/import`, { method: 'POST', body: JSON.stringify(body) }),
  job: (id: string) => req<{
    job: Job;
    qa: QaReport | null;
    artifact: ContentArtifactView | null;
    interactions: ContentReviewInteractionView[];
    site: Site | null;
  }>(`/api/jobs/${id}`),
  updateJobContent: (
    id: string,
    body: ArticleVersion & { category?: string },
  ) => req<{ ok: boolean; job: Job }>(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  setJobVisibility: (id: string, visibility: 'visible' | 'hidden') =>
    req<{ ok: boolean; job: Job }>(`/api/jobs/${id}/visibility`, { method: 'POST', body: JSON.stringify({ visibility }) }),
  localizeJob: (id: string) => req<{ ok: boolean; job: Job }>(`/api/jobs/${id}/localize`, { method: 'POST' }),
  removeJobLocale: (id: string, locale: string) =>
    req<{ ok: boolean; job: Job }>(`/api/jobs/${id}/localizations/${encodeURIComponent(locale)}`, { method: 'DELETE' }),
  approve: (id: string) => req<{ ok: boolean; job: Job }>(`/api/jobs/${id}/approve`, { method: 'POST' }),
  reject: (id: string, review_note: string) =>
    req<{ ok: boolean; job: Job }>(`/api/jobs/${id}/reject`, { method: 'POST', body: JSON.stringify({ review_note }) }),
};

export function siteHref(site: Site, path = '/'): string {
  const base = site.domain_status === 'live' && site.domain ? `https://${site.domain}` : site.live_path;
  if (!path || path === '/') return `${base}/`;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function siteArticleHref(site: Site, locale: string, slug: string): string {
  const prefix =
    site.locale_policy?.locales.find((l) => l.code === locale)?.prefix ||
    locale.split('-')[0].toLowerCase();
  return siteHref(site, `/${prefix}/blog/${slug}`);
}

export const LANG_OPTIONS = ['pt-BR', 'es', 'es-MX', 'fr', 'de', 'it', 'ja', 'ko', 'zh-CN'];
export const SOURCE_OPTIONS = ['en', ...LANG_OPTIONS];

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `Month ${d.getMonth() + 1}, Day ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function jobLocales(job: Job, source = 'en'): string {
  if (job.versions?.length) return job.versions.map((v) => v.locale).join(' · ');
  const extra = (job.translate_locales ?? []).filter((x) => x && x !== source);
  return [source, ...extra].join(' · ');
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export type BusinessResearchProcess = {
  task_id?: string;
  run_id: string; status: string; outcome?: string; reason: string;
  metrics: null | { tool_calls: number; model_calls: number; decision_turns: number; external_calls: number; inference_units: number; saved_documents: number };
  can_resume?: boolean;
  stages?: Array<{ number: number; run_id: string; status: string; tool_calls: number; normal_decisions_start: number; normal_decisions_end: number; decision: { decision?: string; reason?: string; progress?: string; remaining_work?: string; next_stage_method?: string; resume_when?: string }; pending: Array<{ tool: string; module: string; status: string }>; started_at: string; finished_at: string }>;
  steps: Array<{ binding?: { selectors: string[]; resolved_fields: string[] } | null; stage?: number; sequence: number; tool: string; status: string; purpose: string; url: string; module: string; version: number | null; cached: boolean; error: string; characters: number | null; offset: number; started_at: string; finished_at: string }>;
  pending: Array<{ tool: string; module: string; status: string }>;
};


export function libraryQuery(language: LibraryLanguage, query: Record<string, string | number | undefined> = {}) {
  const params = new URLSearchParams({ locale: language.locale });
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
  return params.toString();
}
export const keywordLibraryApi = {
  languages: (siteId: string) => req<{ languages: LibraryLanguage[] }>(`/api/sites/${encodeURIComponent(siteId)}/keyword-library/languages`),
  entries: (siteId: string, language: LibraryLanguage, query: Record<string, string | number | undefined> = {}) => req<LibraryPage>(`/api/sites/${encodeURIComponent(siteId)}/keyword-library/entries?${libraryQuery(language, query)}`),
  detail: (siteId: string, language: LibraryLanguage, id: string, after?: string) => req<LibraryDetail>(`/api/sites/${encodeURIComponent(siteId)}/keyword-library/entries/${encodeURIComponent(id)}?${libraryQuery(language, { after })}`),
  logs: (siteId: string, language: LibraryLanguage, query: Record<string, string | number | undefined> = {}) => req<LibraryLogPage>(`/api/sites/${encodeURIComponent(siteId)}/keyword-library/logs?${libraryQuery(language, query)}`),
  topic: (siteId: string, language: LibraryLanguage, id: string, after?: string) => req<LibraryTopic>(`/api/sites/${encodeURIComponent(siteId)}/keyword-library/topics/${encodeURIComponent(id)}?${libraryQuery(language, { after })}`),
};
