import type { Site } from '../../types';

export const MAX_COMPETITORS = 10;
export const MAX_SEED_TERMS = 20;
export const MAX_PAGES_PER_COMPETITOR = 120;
export const MAX_SITEMAP_NEST = 3;
export const MAX_KEYWORDS_PER_RUN = 36;

export type ResearchConfig = {
  competitor_domains: string[];
  seed_terms: string[];
  product_brief: string;
};

export function researchConfigOf(site: Site): ResearchConfig {
  return {
    competitor_domains: parseStringList(site.competitor_domains_json).slice(0, MAX_COMPETITORS),
    seed_terms: parseStringList(site.research_seed_terms_json).slice(0, MAX_SEED_TERMS),
    product_brief: site.product_brief || '',
  };
}

export function publicResearchConfig(cfg: ResearchConfig) {
  return {
    competitor_domains: cfg.competitor_domains,
    seed_terms: cfg.seed_terms,
    product_brief: cfg.product_brief,
  };
}

export function parseResearchConfigBody(body: Record<string, unknown>, current: ResearchConfig): ResearchConfig {
  return {
    competitor_domains:
      body.competitor_domains != null ? uniqueDomains(asStringArray(body.competitor_domains)) : current.competitor_domains,
    seed_terms: body.seed_terms != null ? uniqueTerms(asStringArray(body.seed_terms)) : current.seed_terms,
    product_brief: body.product_brief != null ? String(body.product_brief) : current.product_brief,
  };
}

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

export function parseStringList(raw: string | null | undefined): string[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function uniqueDomains(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const domain = normalizeDomain(item);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
    if (out.length >= MAX_COMPETITORS) break;
  }
  return out;
}

function uniqueTerms(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const term = item.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_SEED_TERMS) break;
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return [];
}
