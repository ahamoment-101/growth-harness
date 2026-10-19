import { z } from 'zod';
import type { RuntimeAgentEnv } from './env';
import { inspectContentProductionGroup } from './content-production';
import { ToolRegistry } from './tools';
import { coveragePlanTool } from './content-editorial';
import { readContentArticleTool, parentPublishedArticlesTool } from './content-link-reading';
import { editArticleInternalLinksTool } from './content-link-editing';

const judgmentSchema = z.string().trim().min(1).max(1000);

export const inspectContentGroupInputSchema = z.object({
  judgment_summary: judgmentSchema,
});

export const startArticleTasksInputSchema = z.object({
  job_ids: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  editorial_brief: z.string().describe('Writing guidance or targeted revision instructions for the selected authors.'),
  judgment_summary: judgmentSchema,
});

export const startContentReviewsInputSchema = z.object({
  job_ids: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  judgment_summary: judgmentSchema,
});

export const completeContentGroupInputSchema = z.object({
  judgment_summary: judgmentSchema,
});

export const deferContentGroupInputSchema = z.object({
  reason: z.string().trim().min(1).max(1500),
  resume_when: z.string().trim().min(1).max(1200),
  judgment_summary: judgmentSchema,
});

const durableResultSchema = z.object({}).passthrough();

export const LEGACY_START_ARTICLE_TASKS_DESCRIPTION = [
  'Start or locally retry article sub-Agents while preserving successful sibling artifacts.',
  'Select the jobs and supply editorial_brief with writing or revision guidance. Selected authors run concurrently within declared capacity; this call returns their deliverable checkpoints or failures together. Choose batch size and sequencing according to the work.',
  'Validated on submit: every job_id must belong to this group, and each must be actionable — a job that already has a candidate awaiting review, or that already passed, is rejected; inspect the group first and send that one to start_content_reviews instead.',
].join('\n');

/** From definition v20 authors own internal links, so the parent registers no link tools (authorLinks). */
export function createContentProductionToolRegistry(env: RuntimeAgentEnv, groupId = '', editorial = true, linking = true, authorLinks = false): ToolRegistry {
  const registry = new ToolRegistry();
  if (editorial) registry.register(coveragePlanTool(env, groupId));
  if (!authorLinks && linking) registry.register(readContentArticleTool(env, groupId))
    .register(parentPublishedArticlesTool(env, groupId)).register(editArticleInternalLinksTool(env, groupId));
  return registry
    .register({
      name: 'inspect_content_group', version: 1,
      preserveOutputSize: true,
      description: 'Read fresh orchestration metadata for the content group: author Run, candidate artifact, isolated review Run, decision, and failure state. This tool deliberately does not return full article bodies.',
      capability: 'read', inputSchema: inspectContentGroupInputSchema, outputSchema: durableResultSchema,
      timeoutMs: 15_000, retryable: true, approval: 'never',
      execute: async (_input, context) => inspectContentProductionGroup(
        env.DB, context.workspaceId, context.siteId, groupId,
      ),
    })
    .register({
      name: 'start_article_tasks', replaySafety: 'idempotent', version: 1,
      preserveOutputSize: true,
      description: [
        'Start or locally retry article sub-Agents while preserving successful sibling artifacts.',
        'Select the jobs and supply editorial_brief with writing or revision guidance. Selected authors run concurrently within declared capacity; this call returns their deliverable checkpoints or failures together. Choose batch size and sequencing according to the work.',
        'Validated on submit: every job_id must belong to this group and be actionable. Published articles are immutable and cannot be reopened for writing, relinking or review. A candidate awaiting review belongs with start_content_reviews; inspect the group before selecting an action.',
      ].join('\n'),
      capability: 'write', inputSchema: startArticleTasksInputSchema, outputSchema: durableResultSchema,
      timeoutMs: 900_000, retryable: false, approval: 'never', executionMode: 'durable_async',
    })
    .register({
      name: 'start_content_reviews', replaySafety: 'idempotent', version: 1,
      preserveOutputSize: true,
      description: [
        'Start or locally retry one isolated parent-editor review Run per selected latest candidate.',
        'Select candidates for independent review. Reviews run concurrently within declared capacity and return their outcomes together to this conversation.',
        'Full article bodies stay inside those Runs; only compact pass/revise/defer outcomes return here.',
      ].join('\n'),
      capability: 'write', inputSchema: startContentReviewsInputSchema, outputSchema: durableResultSchema,
      timeoutMs: 900_000, retryable: false, approval: 'never', executionMode: 'durable_async',
    })
    .register({
      name: 'complete_content_group', replaySafety: 'idempotent', version: 2,
      preserveOutputSize: true,
      description: 'Close the current group-management Run after every article has reached publication review, publishing, or publication. Validated on submit: the group is rejected if any item is still drafting, failed, or awaiting revision. This action does not approve publication; the subscribed Growth Leader or a human reviews each article separately.',
      capability: 'write', inputSchema: completeContentGroupInputSchema, outputSchema: durableResultSchema,
      timeoutMs: 30_000, retryable: false, approval: 'never', executionMode: 'durable_async',
    })
    .register({
      name: 'defer_content_group', replaySafety: 'idempotent', version: 1,
      preserveOutputSize: true,
      description: 'Stop this Run without losing work when the Agent cannot safely make further progress, with a reason and resume condition.',
      capability: 'write', inputSchema: deferContentGroupInputSchema, outputSchema: durableResultSchema,
      timeoutMs: 30_000, retryable: false, approval: 'never', executionMode: 'durable_async',
    });
}
