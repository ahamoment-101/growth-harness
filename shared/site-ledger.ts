export type LedgerCount = { total: number; yesterday: number };
export type SiteLedger = {
  published: LedgerCount;
  strategies: LedgerCount;
  research: LedgerCount;
  keywords: LedgerCount;
  topics: LedgerCount;
  languages: number;
  sitemap: 'submitted' | 'error' | 'not_submitted';
  search: { impressions: number; clicks: number; from: string; through: string; synced_at: string } | null;
  computed_at: string;
  timezone: 'Asia/Shanghai';
};
export type SiteLedgerResponse = { snapshot: SiteLedger | null; refreshing: boolean; stale: boolean; refresh_failed: boolean };
