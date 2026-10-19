import { readRuntimeJson } from './runtime-content';
import { z } from 'zod';
import type { D1Database } from '@cloudflare/workers-types';
import type { AgentTask } from './task-store';
import { strategyBlueprintSchema, strategyDirectionBlueprintSchema, strategyKeywordSchema } from '../lib/research/ingest';
import { strategyWorkspace, validateStrategyWorkspace, type StrategyWorkspace } from './strategy-task';

const savedWorkspace = (definitionVersion: number) => z.object({
  blueprint: definitionVersion >= 34 ? strategyDirectionBlueprintSchema : strategyBlueprintSchema, keywords: z.array(strategyKeywordSchema) });

/** Reuse an attributable completed working document; never infer editable fields from prose. */
export async function strategyBaseline(db: D1Database, task: AgentTask, locale: string, versionId: string): Promise<{
  workspace: StrategyWorkspace;
  origin: { kind: 'existing_task' | 'completed_strategy' | 'empty' | 'documents_only' | 'new_version_draft'; version_id: string; reason?: string };
}> {
  const current = strategyWorkspace(task);
  if (current.blueprint || current.keywords.length || task.revision > 0) {
    return { workspace: current, origin: { kind: 'existing_task', version_id: versionId } };
  }
  if (!versionId) return { workspace: current, origin: { kind: 'empty', version_id: '' } };
  // From v36 every task writes its own new-version draft; earlier versions are read-only reference, never copied in.
  if ((task.definition_version || 0) >= 36) return { workspace: current, origin: { kind: 'new_version_draft', version_id: versionId,
    reason: 'This task draft starts empty and becomes the next version on submission. The base version stays read-only reference through read_strategy; decide what to keep, adjust or drop and create it in this draft.' } };
  const saved = await db.prepare(`select t.workspace_json from seo_strategy_versions v
    join agent_task_runs r on r.run_id = v.run_id join agent_tasks t on t.id = r.task_id
    where v.id = ? and v.site_id = ? and v.source_locale = ? and v.status != 'draft'
      and t.site_id = v.site_id and t.workspace_id = ? and t.agent_id = 'strategy_research'
      and t.status = 'completed' and t.outcome = 'completed'`).bind(versionId, task.site_id, locale, task.workspace_id).first<{ workspace_json: string }>();
  if (saved) {
    try {
      const parsed = savedWorkspace(task.definition_version || 0).parse(await readRuntimeJson(db, saved.workspace_json));
      validateStrategyWorkspace(parsed, locale);
      // Review approval/assessment belongs to the old revision and is not inherited.
      return { workspace: parsed, origin: { kind: 'completed_strategy', version_id: versionId } };
    } catch {
      // Historical formats may have changed. Preserve the source documents and state the gap.
    }
  }
  return { workspace: current, origin: { kind: 'documents_only', version_id: versionId,
    reason: 'No compatible completed structured draft is available. Read this version with read_strategy and explicitly create any revised blueprint; no fields were inferred from historical prose.' } };
}
