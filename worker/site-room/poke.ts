import type { D1Database } from '@cloudflare/workers-types';

/** The part of the Worker environment that can reach site rooms. Optional so tests and tools can omit it. */
export type RoomEnv = { DB: D1Database; SITE_ROOM?: { idFromName(name: string): unknown; get(id: never): { poke(siteId: string): Promise<void> } } };
/** A running task whose progress (anything its steps wrote) should reach live views. */
export type Progress = { workspaceId: string; taskId: string };

export function roomName(siteId: string) { return `site:${siteId}`; }

// A poke is a Durable Object call and consumes the configured invocation request budget.
// Runtime steps throttle per site: the first poke in a window goes at once, later ones collapse into a single
// trailing poke at the end of the window, so a change is never held behind a long model call.
// The end of an execution, console writes and the minute backstop always go through.
const POKE_INTERVAL_MS = 2000;
const lastPoke = new Map<string, number>();
const trailing = new Map<string, ReturnType<typeof setTimeout>>();
const progressed = new Map<string, Map<string, string>>();

async function sendPoke(env: RoomEnv, siteId: string) {
  lastPoke.set(siteId, Date.now());
  // Record which running tasks progressed since the last poke, at most once per window per task.
  const tasks = progressed.get(siteId);
  progressed.delete(siteId);
  try {
    if (tasks?.size) await env.DB.batch([...tasks].map(([taskId, workspaceId]) =>
      env.DB.prepare("insert into site_changes(workspace_id,site_id,kind,ref) values(?,?,'task_progress',?)").bind(workspaceId, siteId, taskId)));
  } catch (error) {
    console.warn('Task progress not logged', siteId, String(error));
  }
  try {
    await env.SITE_ROOM!.get(env.SITE_ROOM!.idFromName(roomName(siteId)) as never).poke(siteId);
  } catch (error) {
    console.warn('Site room poke pending', siteId, String(error));
  }
}

/** Tell a site's room that its change log may have grown. Carries no data; failures are left to the minute backstop. */
export async function pokeSite(env: RoomEnv, siteId: string, options: { coalesce?: boolean; progress?: Progress } = {}): Promise<void> {
  if (!env.SITE_ROOM || !siteId) return;
  if (options.progress) {
    const tasks = progressed.get(siteId) ?? new Map<string, string>();
    tasks.set(options.progress.taskId, options.progress.workspaceId);
    progressed.set(siteId, tasks);
  }
  const wait = POKE_INTERVAL_MS - (Date.now() - (lastPoke.get(siteId) ?? 0));
  if (options.coalesce && wait > 0) {
    if (!trailing.has(siteId)) trailing.set(siteId, setTimeout(() => { trailing.delete(siteId); void sendPoke(env, siteId); }, wait));
    return;
  }
  const pending = trailing.get(siteId);
  if (pending) { clearTimeout(pending); trailing.delete(siteId); }
  await sendPoke(env, siteId);
}

const CURSOR = 'rooms';
const BACKSTOP_SITES = 200;
const BACKSTOP_WINDOW = 5000;

/**
 * Minute backstop: poke every site whose log grew since the last run, whatever wrote it.
 * Reads only the new change rows (primary-key range), so an idle system reads one row.
 */
export async function pokeChangedSites(env: RoomEnv): Promise<void> {
  const cursor = await env.DB.prepare('select seq from site_change_cursor where name=?').bind(CURSOR).first<{ seq: number }>();
  if (!cursor) {
    const top = await env.DB.prepare('select coalesce(max(seq),0) as seq from site_changes').first<{ seq: number }>();
    await env.DB.prepare('insert or ignore into site_change_cursor(name,seq) values(?,?)').bind(CURSOR, Number(top?.seq ?? 0)).run();
    return;
  }
  // The range comes first (rowid seek, bounded); grouping the table directly makes SQLite walk the
  // whole (site_id, seq) index every minute, i.e. the entire retained log.
  const rows = (await env.DB.prepare(`select site_id,max(seq) as last from (select site_id,seq from site_changes where seq>? order by seq limit ?)
    group by site_id order by last limit ?`).bind(cursor.seq, BACKSTOP_WINDOW, BACKSTOP_SITES).all<{ site_id: string; last: number }>()).results;
  if (!rows.length) return;
  await Promise.all(rows.map(row => pokeSite(env, row.site_id)));
  // Only advance past sites actually poked; a larger backlog continues next minute.
  await env.DB.prepare('update site_change_cursor set seq=max(seq,?) where name=?').bind(Math.max(...rows.map(row => Number(row.last))), CURSOR).run();
}

const RETENTION_MS = 7 * 86_400_000;
const PRUNE_BATCH = 5000;
// An hourly run stops after this long and continues next hour; batches keep each statement short.
const PRUNE_BUDGET_MS = 20_000;

/** Hourly: drop change rows older than seven days, oldest first, until caught up or out of time. */
export async function pruneSiteChanges(env: RoomEnv, now = Date.now()): Promise<void> {
  const cutoff = new Date(now - RETENTION_MS).toISOString();
  const started = Date.now();
  while (Date.now() - started < PRUNE_BUDGET_MS) {
    const oldest = await env.DB.prepare('select seq,created_at from site_changes order by seq limit 1').first<{ seq: number; created_at: string }>();
    if (!oldest || oldest.created_at >= cutoff) return;
    const result = await env.DB.prepare(`delete from site_changes where seq in (select seq from site_changes where seq>=? order by seq limit ?) and created_at<?`)
      .bind(oldest.seq, PRUNE_BATCH, cutoff).run();
    if (!result.meta.changes) return;
  }
}
