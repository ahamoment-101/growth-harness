import type { D1Database } from '@cloudflare/workers-types';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { createConversation, enqueueInput, wakeConversation } from './service';

export const DAILY_TRIGGER_ACTIONS = ['start_topic_batch'] as const;
export type DailyTriggerAction = typeof DAILY_TRIGGER_ACTIONS[number];
export type DailyTrigger = {
  site_id: string;
  workspace_id: string;
  enabled: number;
  task_mode: 'scheduled';
  action: DailyTriggerAction;
  local_time: string;
  timezone: 'Asia/Shanghai';
  next_due_at: string;
  updated_at: string;
};

const OFFSET_MS = 8 * 60 * 60 * 1000;
const localDate = (at: Date) => new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);
export const dailyConversationId = (siteId: string, date: string) => `daily-topics:${siteId}:${date}`;

export function nextDailyDue(localTime: string, at: Date): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw new Error('Please choose a valid daily time');
  const [hour, minute] = localTime.split(':').map(Number);
  const date = localDate(at);
  let due = Date.parse(`${date}T00:00:00.000Z`) + (hour - 8) * 3_600_000 + minute * 60_000;
  if (due <= at.getTime()) due += 86_400_000;
  return new Date(due).toISOString();
}

export async function readDailyTrigger(db: D1Database, workspaceId: string, siteId: string): Promise<DailyTrigger | null> {
  return db.prepare('select * from daily_triggers where workspace_id=? and site_id=?')
    .bind(workspaceId, siteId).first<DailyTrigger>();
}

export async function saveDailyTrigger(db: D1Database, workspaceId: string, siteId: string,
  input: { enabled?: unknown; task_mode?: unknown; action?: unknown; local_time?: unknown }, at = new Date()): Promise<DailyTrigger> {
  if (typeof input.enabled !== 'boolean' || input.task_mode !== 'scheduled' || input.action !== 'start_topic_batch'
    || typeof input.local_time !== 'string') {
    throw new Error('Invalid trigger configuration');
  }
  const nextDue = nextDailyDue(input.local_time, at);
  const result = await db.prepare(`insert into daily_triggers(site_id,workspace_id,enabled,task_mode,action,local_time,timezone,next_due_at,updated_at)
    select ?,?,?,?,?,?,'Asia/Shanghai',?,? from sites where id=? and workspace_id=?
    on conflict(site_id) do update set enabled=excluded.enabled,task_mode=excluded.task_mode,
      action=excluded.action,local_time=excluded.local_time,next_due_at=excluded.next_due_at,updated_at=excluded.updated_at
    where daily_triggers.workspace_id=excluded.workspace_id`)
    .bind(siteId, workspaceId, input.enabled ? 1 : 0, input.task_mode, input.action, input.local_time,
      input.enabled ? nextDue : '', at.toISOString(), siteId, workspaceId).run();
  if (!result.meta.changes) throw new Error('Site does not exist or you lack permission to modify it');
  return (await readDailyTrigger(db, workspaceId, siteId))!;
}

/** Cron records an occurrence first. Pending occurrences are retried with the same input ID. */
export async function dispatchDailyTriggers(env: RuntimeAgentEnv, at = new Date()) {
  const now = at.toISOString();
  const due = (await env.DB.prepare(`select * from daily_triggers where enabled=1 and next_due_at!='' and next_due_at<=?
    order by next_due_at,site_id limit 50`).bind(now).all<DailyTrigger>()).results;
  for (const trigger of due) {
    const date = localDate(at);
    const inputId = `daily-trigger:${trigger.site_id}:${date}`;
    await env.DB.prepare(`insert or ignore into daily_trigger_fires(site_id,local_date,workspace_id,action,input_id,created_at)
      select site_id,?,?,action,?,? from daily_triggers where site_id=? and workspace_id=?
        and enabled=1 and next_due_at=? and action=?`)
      .bind(date, trigger.workspace_id, inputId, now, trigger.site_id, trigger.workspace_id,
        trigger.next_due_at, trigger.action).run();
    await env.DB.prepare('update daily_triggers set next_due_at=? where site_id=? and workspace_id=? and next_due_at=?')
      .bind(nextDailyDue(trigger.local_time, at), trigger.site_id, trigger.workspace_id, trigger.next_due_at).run();
  }
  const pending = (await env.DB.prepare(`select f.site_id,f.workspace_id,f.local_date,f.action,f.input_id from daily_trigger_fires f
    join daily_triggers t on t.site_id=f.site_id and t.workspace_id=f.workspace_id
    where f.delivered_at='' and t.enabled=1 order by f.created_at,f.site_id limit 50`)
    .all<{site_id:string;workspace_id:string;local_date:string;action:DailyTriggerAction;input_id:string}>()).results;
  for (const fire of pending) {
    try {
      const scope = { workspaceId: fire.workspace_id, siteId: fire.site_id };
      const conversationId = dailyConversationId(fire.site_id, fire.local_date);
      await createConversation(env, scope, { id: conversationId, title: `${fire.local_date} daily topic selection`,
        context: 'Per the site\'s saved scheduled trigger configuration, advance a batch of topic selection for the day; topic selection and delegation are judged and executed by the Leader.' });
      await enqueueInput(env, scope, conversationId, { id: fire.input_id, kind: 'assignment', actorId: 'daily_trigger',
        content: `Site scheduled trigger (user-saved configuration): ${fire.local_date}, China Standard Time. Trigger content: start a batch of topic selection. Please review this site's current languages, keyword library, topics, and in-flight work, and coordinate with the Topic Editor to start a suitable batch of topics. Do not delegate duplicates when the same batch of work already exists; if necessary conditions are missing, state the specific blocker. Delegation acceptance does not mean topic selection is complete; follow-up results continue to be tracked in this conversation.` });
      await wakeConversation(env, scope, conversationId, fire.input_id);
      await env.DB.prepare("update daily_trigger_fires set delivered_at=? where site_id=? and local_date=? and delivered_at=''")
        .bind(new Date().toISOString(), fire.site_id, fire.local_date).run();
    } catch (error) { console.error('Daily trigger delivery pending', fire.site_id, fire.local_date, String(error)); }
  }
  return { due: due.length, pending: pending.length };
}
