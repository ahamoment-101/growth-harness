import type { D1Database } from '@cloudflare/workers-types';

export type StopStrategyRunResult = 'not_found' | 'already_terminal' | 'stopped';

export async function stopStrategyResearchRun(
  db: D1Database,
  runId: string,
  reason: string,
): Promise<StopStrategyRunResult> {
  const row = await db.prepare(
    'select status from seo_strategy_runs where id = ?',
  ).bind(runId).first<{ status: 'running' | 'waiting' | 'ok' | 'failed' | 'cancelled' }>();
  if (!row) return 'not_found';
  if (!['running','waiting'].includes(row.status)) return 'already_terminal';
  await db.prepare(
    `update seo_strategy_runs
     set status = 'cancelled', phase = 'cancelled', error = ?, finished_at = ?
     where id = ? and status in ('running','waiting')`,
  ).bind(reason.slice(0, 2000), new Date().toISOString(), runId).run();
  return 'stopped';
}
