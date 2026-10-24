import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { startRuntimeRun } from '../agent-runtime/run-service';
import {
  stopTask,
  taskResumeBlock,
  taskForRun,
} from '../agent-runtime/task-store';
import {
  currentExecution,
  createRuntimeExecution,
  dispatchExecution,
} from '../agent-runtime/runtime-executions';
import {
  now,
  recordPreparationFailure,
  type LearningRequest,
  type RecordRow,
} from './store';
import { executionFailure } from '../agent-runtime/execution-failure';
import { executionContext } from '../agent-runtime/execution-context';

/** System dispatcher consumes durable requests, never a parent's execution credential. */
export async function dispatchLearningRequests(env: RuntimeAgentEnv) {
  if (executionContext(env.DB))
    throw new Error('Learning dispatch needs system authority');
  const at = now();
  const requests = await env.DB.prepare(
    `select q.* from learning_requests q where q.status in ('pending','running') and q.available_at<=?
    and not exists(select 1 from learning_requests earlier where earlier.record_id=q.record_id and earlier.status in ('pending','running')
      and (earlier.created_at<q.created_at or (earlier.created_at=q.created_at and earlier.id<q.id)))
    order by q.available_at,q.id limit 10`,
  )
    .bind(at)
    .all<LearningRequest>();
  for (const request of requests.results) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(request.id),
    );
    const runId =
      request.run_id ||
      'learning-' +
        Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('');
    const record = await env.DB.prepare(
      'select * from learning_records where id=?',
    )
      .bind(request.record_id)
      .first<RecordRow>();
    if (!record) continue;
    const scope = { workspaceId: record.workspace_id, siteId: record.site_id };
    try {
      await env.DB.prepare(
        "update learning_requests set run_id=?,status='running',available_at=?,updated_at=? where id=? and status in ('pending','running')",
      )
        .bind(runId, new Date(Date.now() + 30000).toISOString(), at, request.id)
        .run();
      const task = await taskForRun(env.DB, runId);
      if (!task)
        await startRuntimeRun(env, {
          runId,
          workspaceId: record.workspace_id,
          siteId: record.site_id,
          agentId: 'learning_agent',
          instanceId: runId,
          trigger: 'cron',
          scheduleKey: request.id,
          summary: { request_id: request.id },
        });
      else if (task.status === 'paused' || task.status === 'waiting') {
        const blocker = await taskResumeBlock(env.DB, task);
        if (blocker) {
          await env.DB.prepare(
            'update learning_requests set error=? where id=?',
          )
            .bind(blocker, request.id)
            .run();
          continue;
        }
        if (
          await recordPreparationFailure(
            env.DB,
            scope,
            request,
            `execution:${task.execution_id}`,
            task.reason || 'Learning execution interrupted',
          )
        ) {
          await stopTask(
            env.DB,
            runId,
            'completed',
            'Learning preparation unavailable; business continued',
            'learning_skipped',
          );
          continue;
        }
        const previous = await currentExecution(env.DB, runId);
        const execution = await createRuntimeExecution(
          env.DB,
          runId,
          previous || undefined,
          'learning_retry',
        );
        await dispatchExecution(env, execution);
      } else if (['completed', 'cancelled', 'failed'].includes(task.status)) {
        // A normal completion must have an atomic learning receipt. Never silently drop an unfinished request.
        const message =
          task.reason || 'Learning task ended without a saved result';
        if (request.phase === 'prepare')
          await recordPreparationFailure(
            env.DB,
            scope,
            request,
            `terminal:${task.execution_id}`,
            message,
            true,
          );
        else
          await env.DB.prepare(
            "update learning_requests set status='failed',error=?,updated_at=? where id=? and status='running'",
          )
            .bind(message, at, request.id)
            .run();
      }
    } catch (error) {
      // startRuntimeRun and tool commits have stable receipts. Re-read before degrading an unknown response.
      const saved = await env.DB.prepare(
        'select status from learning_requests where id=?',
      )
        .bind(request.id)
        .first<{ status: string }>();
      if (saved && ['completed', 'skipped'].includes(saved.status)) continue;
      const task = await taskForRun(env.DB, runId);
      if (!task)
        await recordPreparationFailure(
          env.DB,
          scope,
          request,
          `dispatch:${request.failure_count}`,
          String(error),
          executionFailure(error)?.origin === 'configuration',
        );
      await env.DB.prepare(
        'update learning_requests set error=?,available_at=?,updated_at=? where id=?',
      )
        .bind(
          String(error).slice(0, 1000),
          new Date(Date.now() + 60000).toISOString(),
          at,
          request.id,
        )
        .run();
    }
  }
  return { inspected: requests.results.length };
}
