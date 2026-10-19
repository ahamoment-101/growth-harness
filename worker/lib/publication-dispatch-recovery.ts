import type { D1Database } from '@cloudflare/workers-types';
import { readRuntimeJson } from '../agent-runtime/runtime-content';
import { workflowInstanceId } from './workflow-instance-id';

type PendingPublication = {
  id: string;
  workflow_id: string;
  publication_operation_id: string;
  publication_locales_json: string;
  versions_json: string;
  policy_json: string | null;
};

type PublicationPolicy = { mode: string; enabled_locales: string[] };

function dispatchLocales(row: PendingPublication): string[] | null {
  if (!row.workflow_id.startsWith('publish:')) return JSON.parse(row.publication_locales_json) as string[];
  return null;
}

async function originalLocales(db: D1Database, row: PendingPublication): Promise<string[] | null> {
  const snapshot = dispatchLocales(row);
  if (snapshot) return snapshot;
  if (!row.policy_json) return null;
  const policy = await readRuntimeJson<PublicationPolicy>(db, row.policy_json);
  if (!Array.isArray(policy.enabled_locales) || !['all_enabled', 'source_only'].includes(policy.mode)) return null;
  const existing = new Set((JSON.parse(row.versions_json) as Array<{ locale: string }>).map(version => version.locale.toLowerCase()));
  return policy.mode === 'source_only' ? [] : policy.enabled_locales.filter(locale => !existing.has(locale.toLowerCase()));
}

/** Reconcile a persisted Leader approval against the provider before redispatching it. */
export async function reconcilePublicationDispatches(env: Env, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 120_000).toISOString();
  const { results } = await env.DB.prepare(`select j.id,j.workflow_id,j.publication_operation_id,j.publication_locales_json,j.versions_json,
      p.value_json as policy_json from jobs j
      left join agent_task_operations o on o.id=j.publication_operation_id
      left join agent_parameter_slots p on p.task_id=o.task_id and p.kind='leader_publication_policy'
        and p.ref=json_extract(o.action_json,'$.input.publication_policy_ref')
      where j.status='publishing' and j.publication_operation_id!='' and j.updated_at<?
      order by j.updated_at limit 10`).bind(cutoff).all<PendingPublication>();
  let dispatched = 0;
  for (const row of results) {
    try {
      const desiredId = workflowInstanceId('publish', row.publication_operation_id);
      const legacyId = `publish:${row.publication_operation_id}`;
      if (row.workflow_id !== desiredId && row.workflow_id !== legacyId) continue;
      const locales = await originalLocales(env.DB, row);
      if (!locales) continue; // No exact original payload: retain the claim for inspection.
      if (row.workflow_id === legacyId) {
        // The old ID contains ':' and Cloudflare could never have accepted it.
        const changed = await env.DB.prepare(`update jobs set workflow_id=?,publication_locales_json=?,updated_at=?
          where id=? and status='publishing' and workflow_id=? and publication_operation_id=?`)
          .bind(desiredId, JSON.stringify(locales), now.toISOString(), row.id, legacyId, row.publication_operation_id).run();
        if (!changed.meta.changes) continue;
      }
      try {
        const instance = await env.PUBLISH_WORKFLOW.get(desiredId);
        const status = await instance.status();
        if (status.status !== 'errored' && status.status !== 'terminated') continue;
        console.error('Publication Workflow stopped; reconcile its steps', row.id, status.status);
        continue;
      } catch (error) {
        if (!String(error).includes('instance.not_found')) throw error;
      }
      const params = locales.length ? { jobId: row.id, localizationLocales: locales } : { jobId: row.id };
      // Cloudflare createBatch skips an existing instance with the same ID.
      await env.PUBLISH_WORKFLOW.createBatch([{ id: desiredId, params }]);
      dispatched += 1;
    } catch (error) {
      console.error('Publication dispatch reconciliation failed', row.id, String(error));
    }
  }
  return dispatched;
}
