import type { Ai, D1Database, Vectorize } from '@cloudflare/workers-types';
import type { LearningRecord, LearningScope } from '../../shared/learning';
import { recordView, type RecordRow } from './store';

export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const EMBEDDING_PROFILE = 'bge-m3-1024-projection-v1';
export const EMBEDDING_DIMENSIONS = 1024;
export interface LearningSearchBindings {
  AI?: Pick<Ai, 'run'>;
  LEARNING_VECTOR_INDEX?: Pick<Vectorize, 'upsert' | 'getByIds' | 'query' | 'deleteByIds'>;
}
type SearchEnv = LearningSearchBindings & { DB: D1Database };
type IndexJob = {
  record_id: string; generation: number; workspace_id: string; site_id: string;
  document_json: string; profile: string; state: string; vector_id: string;
  content_hash: string; mutation_id: string; attempts: number;
};
class LearningIndexContractError extends Error {}
export async function searchHash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, '0')).join('');
}
export function searchNamespace(scope: LearningScope) {
  return searchHash(JSON.stringify([EMBEDDING_PROFILE, scope.workspaceId, scope.siteId]));
}
export function embeddingText(document: string) {
  return Object.entries(JSON.parse(document) as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== '' && !(Array.isArray(value) && !value.length))
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join('\n') : String(value)}`).join('\n');
}

/** Embeddings transform text; they make no business decision and never call a chat model. */
export async function embedLearningText(env: LearningSearchBindings, text: string) {
  if (!env.AI) throw new Error('Learning embeddings are not configured');
  const response = await env.AI.run(EMBEDDING_MODEL, { text: [text], truncate_inputs: false }) as { data?: number[][] };
  const vector = response?.data?.[0];
  if (!vector || response.data?.length !== 1 || vector.length !== EMBEDDING_DIMENSIONS
    || !vector.every(Number.isFinite) || !vector.some((v) => v !== 0)) {
    throw new LearningIndexContractError('Learning embedding response has an invalid shape or values');
  }
  return vector;
}

const after = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000).toISOString();

/** Durable outbox: immutable vector IDs prevent a slow old write replacing a newer meaning. */
export async function processLearningSearch(env: SearchEnv, at = new Date(), limit = 10) {
  if (!env.AI || !env.LEARNING_VECTOR_INDEX) return { status: 'configuration_missing', processed: 0 };
  const jobs = (await env.DB.prepare(`select * from learning_search_jobs
    where state in ('pending','confirming','retiring') and available_at<=? and lease_until<=?
    order by available_at,record_id,generation limit ?`).bind(at.toISOString(), at.toISOString(), limit).all<IndexJob>()).results;
  let processed = 0;
  for (const job of jobs) {
    const clock = () => new Date(Math.max(at.getTime(), Date.now()));
    const started = clock();
    const lease = crypto.randomUUID();
    const claimed = await env.DB.prepare(`update learning_search_jobs set lease_token=?,lease_until=?,attempts=attempts+1
      where record_id=? and generation=? and state=? and lease_until<=?`)
      .bind(lease, after(started, 120), job.record_id, job.generation, job.state, started.toISOString()).run();
    if (!claimed.meta.changes) continue;
    const update = (state: string, error: string, next: string) => env.DB.prepare(`update learning_search_jobs
      set state=?,error=?,available_at=?,lease_token='',lease_until=''
      where record_id=? and generation=? and lease_token=? and state=?`)
      .bind(state, error, next, job.record_id, job.generation, lease, job.state).run();
    try {
      if (job.profile !== EMBEDDING_PROFILE) throw new LearningIndexContractError('Learning index profile requires its matching executor');
      if (job.state === 'retiring' && !job.vector_id) {
        // No external write can precede the saved vector identity.
        await update('deleted', '', clock().toISOString());
        processed++;
        continue;
      }
      const vectorId = job.vector_id || await searchHash(JSON.stringify([job.profile, job.workspace_id, job.site_id, job.record_id, job.generation]));
      const contentHash = job.content_hash || await searchHash(job.document_json);
      // Save effect identity before the external write, including for unknown-response recovery.
      await env.DB.prepare(`update learning_search_jobs set vector_id=?,content_hash=?
        where record_id=? and generation=? and lease_token=?`)
        .bind(vectorId, contentHash, job.record_id, job.generation, lease).run();
      if (job.state === 'retiring') {
        // Retain a tombstone. Queries also reject superseded/deleted records in D1.
        await env.LEARNING_VECTOR_INDEX.deleteByIds([vectorId]);
        await update('deleted', '', clock().toISOString());
      } else {
        const namespace = await searchNamespace({ workspaceId: job.workspace_id, siteId: job.site_id });
        const existing = await env.LEARNING_VECTOR_INDEX.getByIds([vectorId]);
        const visible = existing.some((v) => v.id === vectorId && v.namespace === namespace
          && v.metadata?.content_hash === contentHash && v.metadata?.profile === job.profile);
        if (visible) {
          await update('ready', '', clock().toISOString());
        } else {
          // An acknowledged mutation is asynchronous. Wait for visibility instead of repeatedly embedding.
          if (!job.mutation_id) {
            const values = await embedLearningText(env, embeddingText(job.document_json));
            const receipt = await env.LEARNING_VECTOR_INDEX.upsert([{
              id: vectorId, namespace, values,
              metadata: { record_id: job.record_id, workspace_id: job.workspace_id, site_id: job.site_id,
                generation: job.generation, content_hash: contentHash, profile: job.profile },
            }]);
            await env.DB.prepare(`update learning_search_jobs set mutation_id=?
              where record_id=? and generation=? and lease_token=?`)
              .bind(receipt.mutationId, job.record_id, job.generation, lease).run();
          }
          await update('confirming', '', after(clock(), 5));
        }
      }
      processed++;
    } catch (error) {
      // Provider errors may contain request material/credentials; persist only a bounded operational message.
      if (error instanceof LearningIndexContractError) {
        // A known protocol mismatch needs a corrected adapter/profile, not repeated paid calls.
        await update('blocked', error.message, clock().toISOString());
      } else {
        await update(job.state, 'Semantic index operation failed; retained for retry.', after(clock(), Math.min(300, 5 * 2 ** Math.min(job.attempts, 6))));
      }
    }
  }
  return { status: 'processed', processed };
}

export async function learningSearchCoverage(db: D1Database, scope: LearningScope) {
  const rows = (await db.prepare(`select j.state,count(*) as count,sum(case when j.error!='' then 1 else 0 end) as errors
    from learning_search_sources s join learning_search_jobs j on s.record_id=j.record_id and s.generation=j.generation
    where s.workspace_id=? and s.site_id=? group by j.state`).bind(scope.workspaceId, scope.siteId)
    .all<{ state: string; count: number; errors: number }>()).results;
  const total = rows.reduce((n, r) => n + r.count, 0);
  const ready = rows.find((r) => r.state === 'ready')?.count || 0;
  const blocked = rows.find((r) => r.state === 'blocked')?.count || 0;
  return { total, ready, pending: total - ready - blocked, blocked, errors: rows.reduce((n, r) => n + r.errors, 0), complete: total === ready };
}

/** Bounded cards. Full evidence and exact version references come from the existing read tool. */
export function experienceCard(record: LearningRecord) {
  const truncated: string[] = [];
  const excerpt = (value: string | undefined, field: string) => {
    if (!value) return '';
    if (value.length <= 700) return value;
    truncated.push(field);
    return value.slice(0, 700) + '…';
  };
  return {
    id: record.id, version: record.version, title: record.title, status: record.status,
    intent: Object.fromEntries(Object.entries(record.intent).map(([k, v]) => [k, excerpt(v, `intent.${k}`)])),
    experience: {
      hypothesis: excerpt(record.experience.hypothesis, 'hypothesis'),
      approach: excerpt(record.experience.approach, 'approach'),
      adjustments: excerpt(record.experience.adjustments.join('\n'), 'adjustments'),
      delivery: excerpt(record.experience.delivery, 'delivery'),
      insight: excerpt(record.experience.insight, 'insight'),
      reward: record.experience.assessment?.reward ?? null,
      conclusion: excerpt(record.experience.assessment?.conclusion, 'conclusion'),
      limitations: excerpt([...(record.experience.assessment?.limitations || []), ...record.experience.gaps].join('\n'), 'limitations'),
      preparation: record.experience.preparation,
    },
    utility: record.utility, truncated_fields: truncated, updated_at: record.updated_at,
  };
}

export async function searchLearning(env: SearchEnv, scope: LearningScope, query: string, topK = 10) {
  if (!query.trim()) throw new Error('Semantic search requires an intent; use the directory to browse history.');
  // Vectorize's documented response limit with all metadata is 50; this is not a relevance threshold.
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) throw new Error('Vectorize top_k must be between 1 and 50');
  const coverage = await learningSearchCoverage(env.DB, scope);
  const base = { mode: 'semantic' as const, profile: EMBEDDING_PROFILE, coverage,
    interpretation: 'Candidates are semantic neighbors, not proven applicable lessons. Similarity is neither utility nor probability. Read evidence and decide fit; no match is not proof that relevant history does not exist.',
  };
  if (!env.AI || !env.LEARNING_VECTOR_INDEX) return { ...base, status: 'configuration_missing', records: [], discarded: 0 };
  try {
    const values = await embedLearningText(env, query);
    const response = await env.LEARNING_VECTOR_INDEX.query(values, {
      namespace: await searchNamespace(scope), topK, returnMetadata: 'all', returnValues: false,
    });
    const matches = response.matches;
    if (!matches.length) return { ...base, status: 'ok', records: [], discarded: 0 };
    // IDs from an external search service convey no authority. Hydrate only current, scoped D1 rows.
    const rows = (await env.DB.prepare(`select r.*,j.vector_id,j.content_hash,j.profile from learning_search_jobs j indexed by learning_search_jobs_vector
      join learning_search_sources s on s.record_id=j.record_id and s.generation=j.generation
      join learning_records r on r.id=s.record_id
      where r.workspace_id=? and r.site_id=? and j.state in ('ready','confirming')
      and j.vector_id!='' and j.vector_id in (${matches.map(() => '?').join(',')})`)
      .bind(scope.workspaceId, scope.siteId, ...matches.map((m) => m.id))
      .all<RecordRow & { vector_id: string; content_hash: string; profile: string }>()).results;
    const byId = new Map(rows.map((r) => [r.vector_id, r]));
    const records = matches.flatMap((match) => {
      const row = byId.get(match.id);
      if (!row || row.profile !== EMBEDDING_PROFILE || match.metadata?.profile !== EMBEDDING_PROFILE
        || match.metadata?.content_hash !== row.content_hash || !Number.isFinite(match.score)) return [];
      return [{ ...experienceCard(recordView(row)), similarity: match.score }];
    });
    return { ...base, status: 'ok', records, discarded: matches.length - records.length };
  } catch (error) {
    if (error instanceof LearningIndexContractError) return { ...base, status: 'protocol_error', records: [], discarded: 0,
      limitation: error.message + '. Saved history remains available through the directory; the embedding adapter/profile needs correction.' };
    return { ...base, status: 'temporarily_unavailable', records: [], discarded: 0,
      limitation: 'Semantic retrieval failed. Saved history remains available through the paginated directory and detail tools.' };
  }
}
