import { observedFetch } from '../../agent-runtime/request-accounting';
import { MAX_PAGES_PER_COMPETITOR, MAX_SITEMAP_NEST } from './config';

const FETCH_HEADERS = {
  Accept: 'application/xml,text/xml,application/json,*/*',
  'User-Agent': 'BlogAgentResearch/0.1',
};

export type FetchedPage = {
  url: string;
  title: string;
  keyword_hint: string;
};

export type SitemapFetchResult = {
  domain: string;
  sitemap_url: string;
  pages: FetchedPage[];
  error: string;
};

export type AutocompleteResult = {
  seed: string;
  suggestions: string[];
  error: string;
};

export async function fetchCompetitorSitemap(domain: string): Promise<SitemapFetchResult> {
  const sitemapUrl = `https://${domain}/sitemap.xml`;
  try {
    const urls = await collectSitemapUrls(sitemapUrl, 0);
    const pages = urls.slice(0, MAX_PAGES_PER_COMPETITOR).map((url) => ({
      url,
      title: '',
      keyword_hint: keywordHintFromUrl(url),
    }));
    return { domain, sitemap_url: sitemapUrl, pages, error: '' };
  } catch (err) {
    return {
      domain,
      sitemap_url: sitemapUrl,
      pages: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchAutocomplete(seed: string, locale = ''): Promise<AutocompleteResult> {
  const q = seed.trim();
  if (!q) return { seed, suggestions: [], error: '' };
  const url = autocompleteUrl(q, locale);
  try {
    const res = await observedFetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    if (!res.ok) return { seed: q, suggestions: [], error: `autocomplete ${res.status}` };
    const parsed = JSON.parse(text) as unknown;
    const suggestions = Array.isArray(parsed) && Array.isArray(parsed[1]) ? parsed[1].map((x) => String(x)).filter(Boolean) : [];
    return { seed: q, suggestions: suggestions.slice(0, 12), error: '' };
  } catch (err) {
    return { seed: q, suggestions: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export function autocompleteUrl(seed: string, locale = ''): string {
  const params = new URLSearchParams({ client: 'firefox', q: seed });
  if (locale) {
    try {
      const parsed = new Intl.Locale(locale);
      if (parsed.language) params.set('hl', parsed.language);
      if (parsed.region) params.set('gl', parsed.region.toLowerCase());
    } catch {
      // Unknown custom locale: the searched seed still carries the Agent's target language.
    }
  }
  return `https://suggestqueries.google.com/complete/search?${params.toString()}`;
}

export function parseSitemapXml(xml: string): { locs: string[]; nested: string[] } {
  const locs: string[] = [];
  const nested: string[] = [];
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const re = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const loc = decodeXml(m[1].trim());
    if (!loc) continue;
    if (isIndex) nested.push(loc);
    else locs.push(loc);
  }
  return { locs, nested };
}

export function keywordHintFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    const last = path.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last)
      .replace(/\.(html?|xml)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

async function collectSitemapUrls(url: string, depth: number): Promise<string[]> {
  if (depth > MAX_SITEMAP_NEST) return [];
  const xml = await fetchText(url);
  const { locs, nested } = parseSitemapXml(xml);
  if (locs.length) return locs;
  const out: string[] = [];
  for (const child of nested.slice(0, 5)) {
    if (out.length >= MAX_PAGES_PER_COMPETITOR) break;
    const more = await collectSitemapUrls(child, depth + 1);
    out.push(...more);
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const res = await observedFetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`fetch ${url} ${res.status}`);
  return res.text();
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
