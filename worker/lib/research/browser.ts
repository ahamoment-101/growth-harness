import type { RuntimeAgentEnv } from '../../agent-runtime/env';
import { reserveExternalUsage } from '../../agent-runtime/task-usage';
import { observedFetch } from '../../agent-runtime/request-accounting';
import { publicResearchUrl } from './url';
export { publicResearchUrl } from './url';
export async function readWebPage(env: RuntimeAgentEnv, runId: string, value: string): Promise<string> {
  const url = publicResearchUrl(value);
  if (!env.FIRECRAWL_API_KEY) throw new Error('FIRECRAWL_API_KEY is not configured');
  const receipt = await reserveExternalUsage(env.DB, runId, 'firecrawl_scrape');
  const response = await observedFetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.FIRECRAWL_API_KEY}` },
    body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: false, timeout: 45000 }),
    signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) throw new Error(`Firecrawl scrape HTTP ${response.status}`);
  const payload = await response.json() as { success?: boolean; data?: { markdown?: unknown; metadata?: { creditsUsed?: number } } };
  const credits = payload.data?.metadata?.creditsUsed;
  await env.DB.prepare('update agent_task_external_usage set provider_credits = ? where id = ?')
    .bind(typeof credits === 'number' && Number.isFinite(credits) ? Math.max(0, credits) : null, receipt).run();
  const markdown = payload.data?.markdown;
  if (payload.success !== true || typeof markdown !== 'string' || !markdown.trim()) throw new Error('Firecrawl returned no readable page; try another source');
  if (new TextEncoder().encode(markdown).length > 2_000_000) throw new Error('Page exceeds 2 MB snapshot limit; use a narrower source');
  return markdown;
}
