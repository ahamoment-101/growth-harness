import type { SiteLedger, SiteLedgerResponse } from '../../shared/site-ledger';
import { aggregateLedger } from './aggregate';

export const LEDGER_TTL_MS = 5 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const RETRY_MS = 60 * 1000;
type Scope = { db: D1Database; workspaceId: string; siteId: string };
type Stored = { payload_json: string | null; computed_at: number; lease_until: number; retry_after: number };
type Options = { now?: () => number; compute?: typeof aggregateLedger; waitUntil: (work: Promise<unknown>) => void };

/** A rebuildable read cache; the lease prevents simultaneous page visits recomputing the same site. */
export async function readSiteLedger(scope: Scope, options: Options): Promise<SiteLedgerResponse> {
  const clock = options.now || Date.now;
  const now = clock();
  const read = () => scope.db.prepare('select payload_json,computed_at,lease_until,retry_after from site_ledger_snapshots where workspace_id=? and site_id=?')
    .bind(scope.workspaceId, scope.siteId).first<Stored>();
  const response = (row: Stored | null, refreshing = false): SiteLedgerResponse => ({
    snapshot: row?.payload_json ? JSON.parse(row.payload_json) as SiteLedger : null,
    refreshing: refreshing || (row?.lease_until || 0) > clock(),
    stale: !row?.payload_json || row.computed_at <= clock() - LEDGER_TTL_MS,
    refresh_failed: (row?.retry_after || 0) > clock(),
  });
  const current = await read();
  if (current?.payload_json && current.computed_at > now - LEDGER_TTL_MS) return response(current);
  if (current && (current.lease_until > now || current.retry_after > now)) return response(current);
  const lease = crypto.randomUUID();
  const claim = await scope.db.prepare(`insert into site_ledger_snapshots(workspace_id,site_id,lease_token,lease_until)
    select workspace_id,id,?,? from sites where workspace_id=? and id=?
    on conflict(workspace_id,site_id) do update set lease_token=excluded.lease_token,lease_until=excluded.lease_until
    where site_ledger_snapshots.lease_until<=? and site_ledger_snapshots.retry_after<=?
      and (site_ledger_snapshots.payload_json is null or site_ledger_snapshots.computed_at<=?)`)
    .bind(lease, now + LEASE_MS, scope.workspaceId, scope.siteId, now, now, now - LEDGER_TTL_MS).run();
  if (!claim.meta.changes) return response(await read());
  const refresh = async () => {
    try {
      const snapshot = await (options.compute || aggregateLedger)(scope, now);
      // A replaced lease cannot overwrite a newer snapshot, even if its computation eventually finishes.
      await scope.db.prepare(`update site_ledger_snapshots set payload_json=?,computed_at=?,lease_token='',lease_until=0,retry_after=0
        where workspace_id=? and site_id=? and lease_token=?`)
        .bind(JSON.stringify(snapshot), now, scope.workspaceId, scope.siteId, lease).run();
    } catch (error) {
      console.error('Site ledger refresh failed', { siteId: scope.siteId, error: error instanceof Error ? error.name : 'UnknownError' });
      await scope.db.prepare(`update site_ledger_snapshots set lease_token='',lease_until=0,retry_after=?
        where workspace_id=? and site_id=? and lease_token=?`)
        .bind(clock() + RETRY_MS, scope.workspaceId, scope.siteId, lease).run();
    }
  };
  if (current?.payload_json) {
    options.waitUntil(refresh());
    return response(current, true);
  }
  await refresh();
  return response(await read());
}
