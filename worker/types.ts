export type JobStatus =
  | 'queued'
  | 'drafting'
  | 'qa'
  | 'awaiting_review'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'publish_failed';

export type JobVisibility = 'visible' | 'hidden';

export type TopicStatus = 'queued' | 'used';

export type WebhookField = {
  key: string;
  from: string;
  value?: string;
};

export type Site = {
  id: string;
  workspace_id: string;
  name: string;
  domain: string;
  root_domain: string;
  ingest_url: string;
  ingest_secret: string;
  secret_header: string;
  locales_json: string;
  translate_locales_json: string;
  webhook_fields_json: string;
  webhook_mode: string;
  hub_path: string;
  product_origin: string;
  locale_policy_json: string;
  source_locale: string;
  hub_urls_json: string;
  seo_identity_json: string;
  name_by_locale_json?: string | null;
  blog_layout: string;
  publication_language_mode?: 'all_enabled' | 'source_only';
  model: string;
  min_words: number;
  created_at: string;
  domain_status: string;
  domain_error: string;
  domain_checked_at: string;

  gsc_oauth_status: string;
  gsc_google_account_email: string;
  gsc_property_url_prefix: string;
  gsc_property_verification_status: string;
  gsc_property_verified_at: string;
  gsc_verification_meta_token: string;
  gsc_sitemap_submit_status: string;
  gsc_sitemap_last_submit_at: string;
  gsc_refresh_token_cipher: string;

  research_enabled: number;
  research_timezone: string;
  research_weekday: number;
  research_hour: number;
  competitor_domains_json: string;
  research_seed_terms_json: string;
  product_brief: string;
};

export type AppUser = {
  id: string;
  google_sub: string;
  email: string;
  display_name: string;
  avatar_url: string;
  created_at: string;
  last_login_at: string;
};

export type Workspace = {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
};

export const EMPTY_SITE_GSC = {
  gsc_oauth_status: 'unconnected',
  gsc_google_account_email: '',
  gsc_property_url_prefix: '',
  gsc_property_verification_status: 'unverified',
  gsc_property_verified_at: '',
  gsc_verification_meta_token: '',
  gsc_sitemap_submit_status: 'idle',
  gsc_sitemap_last_submit_at: '',
  gsc_refresh_token_cipher: '',
} as const;

export const EMPTY_SITE_RESEARCH = {
  research_enabled: 0,
  research_timezone: 'Asia/Shanghai',
  research_weekday: 1,
  research_hour: 9,
  competitor_domains_json: '[]',
  research_seed_terms_json: '[]',
  product_brief: '',
} as const;

export type ResearchRunStatus = 'running' | 'ok' | 'failed';
export type ResearchTrigger = 'manual' | 'cron';

export type Competitor = {
  id: string;
  site_id: string;
  domain: string;
  brand: string;
  positioning: string;
  source: string;
  first_seen_at: string;
  last_fetched_at: string;
};

export type CompetitorPage = {
  id: string;
  competitor_id: string;
  url: string;
  title: string;
  keyword_hint: string;
  content_type: string;
  fetched_at: string;
};

export type Keyword = {
  id: string;
  site_id: string;
  cluster: string;
  term: string;
  intent: string;
  content_type: string;
  volume_hint: string;
  status: string;
  source: string;
  evidence: string;
  created_at: string;
  updated_at: string;
};

export type ResearchDoc = {
  id: string;
  site_id: string;
  doc_type: string;
  version: number;
  body: string;
  produced_by: string;
  created_at: string;
};

export type ResearchRun = {
  id: string;
  site_id: string;
  trigger: string;
  status: ResearchRunStatus;
  workflow_id: string;
  error: string;
  summary_json: string;
  started_at: string;
  finished_at: string;
};

export type StrategyResearchParams = { siteId: string; runId: string };

export type Topic = {
  id: string;
  site_id: string;
  topic_key: string;
  title_hint: string;
  category: string;
  primary_keyword: string;
  status: TopicStatus;
  created_at: string;
  decision_group_id?: string | null;
  decision_item_id?: string | null;
  plan_json?: string;
};

export type Job = {
  url_aliases_json?: string;
  id: string;
  site_id: string;
  topic_id: string | null;
  status: JobStatus;
  visibility: JobVisibility;
  translation_group: string | null;
  category: string | null;
  translate_locales_json: string | null;
  source_locale?: string;
  versions_json: string;
  en_slug: string | null;
  en_title: string | null;
  en_excerpt: string | null;
  en_content: string | null;
  pt_slug: string | null;
  pt_title: string | null;
  pt_excerpt: string | null;
  pt_content: string | null;
  qa_report: string | null;
  review_note: string | null;
  workflow_id: string | null;
  publication_operation_id?: string;
  publication_locales_json?: string;
  error: string | null;
  publish_response: string | null;
  published_at: string | null;
  content_updated_at: string | null;
  decision_group_id?: string | null;
  decision_item_id?: string | null;
  plan_json?: string;
  production_group_id?: string;
  current_artifact_id?: string;
  child_run_id?: string;
  created_at: string;
  updated_at: string;
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

export type IngestPayload = {
  translation_group: string;
  category: string;
  status: 'published';
  dry_run?: boolean;
  versions: ArticleVersion[];
};

export type QaIssue = { code: string; message: string };

export type QaReport = {
  ok: boolean;
  issues: QaIssue[];
};

export type PublishParams = { jobId: string; localizationLocales?: string[] };
