// Opt-in paid DataForSEO checks: DATAFORSEO_LIVE_VERIFY=1 npx vitest run worker/lib/research/dataforseo.live.test.ts
// Writes to an in-memory database only. DATAFORSEO_LIVE_OUT saves the raw results as JSON.
// @ts-ignore Test-only Node API.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lookupKeywordMetrics, lookupSerp, readSearchData } from '../../keyword-library/search-data';
import { schemaTestDb } from '../schema-test-db';

// @ts-ignore Test-only Node environment.
const env = process.env as Record<string, string | undefined>;
const live = env.DATAFORSEO_LIVE_VERIFY === '1';
function credentials() {
  const vars: Record<string, string> = {};
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const match = line.match(/^(DATAFORSEO_[A-Z]+)=(.*)$/);
    if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { login: vars.DATAFORSEO_LOGIN, password: vars.DATAFORSEO_PASSWORD };
}

describe.skipIf(!live)('DataForSEO live lookups', () => {
  it('records metrics and a SERP for real library keywords and reads them back', async () => {
    const { db } = schemaTestDb();
    const report: Record<string, unknown> = {};
    const pt = { workspace_id: 'w', site_id: 's', locale: 'pt-BR' };
    const en = { workspace_id: 'w', site_id: 's', locale: 'en' };
    const ptKeywords = ['email formal em inglês', 'como escrever email em inglês', 'resposta de email em inglês', 'agradecimento email em inglês', 'mensagem em inglês no slack'];
    const enKeywords = ['formal email phrases', 'how to end an email professionally', 'grammarly alternative'];
    const metricsBR = await lookupKeywordMetrics(db, credentials(), pt, { country: 'BR', keywords: ptKeywords });
    const metricsUS = await lookupKeywordMetrics(db, credentials(), en, { country: 'US', keywords: enKeywords });
    const serp = await lookupSerp(db, credentials(), pt, { country: 'BR', keyword: 'email formal em inglês', depth: 10 });
    report.metrics_br = metricsBR; report.metrics_us = metricsUS; report.serp_br = serp;
    const stored = await readSearchData(db, pt, ptKeywords);
    report.read_back = Object.fromEntries(stored);
    if (env.DATAFORSEO_LIVE_OUT) writeFileSync(env.DATAFORSEO_LIVE_OUT, JSON.stringify(report, null, 2));
    expect(metricsBR.rows).toHaveLength(ptKeywords.length);
    expect(metricsUS.rows).toHaveLength(enKeywords.length);
    expect(serp.snapshot.results.length).toBeGreaterThan(0);
    expect(stored.size).toBe(ptKeywords.length);
  }, 120_000);
});
