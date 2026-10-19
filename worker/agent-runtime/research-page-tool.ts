import { z } from 'zod';
import type { RuntimeAgentEnv } from './env';
import type { RuntimeTool } from './tools';
import { requireTask } from './task-store';
import { publicResearchUrl, readWebPage } from '../lib/research/browser';
import { readSource, readSourcePage, saveSource, sourceIndex, sourceReference } from '../lib/research/evidence';
import { sourceTextPage } from '../lib/research/source-pages';

export const readResearchPageInput = z.object({
  purpose: z.string().min(1).max(2000).describe('The factual gap this page could resolve'),
  url: z.string(), reread: z.boolean().default(false),
});

/** Shared page acquisition; the task binding owns the snapshot and its resource usage. */
export function researchPageTool(env: RuntimeAgentEnv, name: string, paged = false): RuntimeTool<z.infer<typeof readResearchPageInput>, unknown> {
  return { name, version: paged ? 2 : 1, capability: 'external', replaySafety: 'repeatable', timeoutMs: 60000,
    retryable: false, approval: 'never', preserveOutputSize: true, inputSchema: readResearchPageInput, outputSchema: z.unknown(),
    description: 'Read a public page and save its full immutable Markdown snapshot. Reuse the saved snapshot unless reread is true. Returns source identity and a readable excerpt; read the source by its ID to continue through the full text.',
    execute: async (args, context) => {
      const current = await requireTask(env.DB, context.runId);
      const url = publicResearchUrl(args.url);
      const known = args.reread ? undefined : (await sourceIndex(env, current.id)).filter(s => s.url === url).at(-1);
      if (known && paged) {
        const { source, ...page } = await readSourcePage(env, current, known.id, 0);
        return { ...source, source_reference: sourceReference(source), evidence_status: 'page_snapshot', ...page };
      }
      const content = known ? (await readSource(env, current, known.id)).content : await readWebPage(env, current.active_run_id, url);
      const source = known || await saveSource(env, current, url, content);
      return { ...source, source_reference: sourceReference(source), evidence_status: 'page_snapshot',
        ...(paged ? sourceTextPage(content, 0) : {
        excerpt: content.slice(0, 16000), next_offset: content.length > 16000 ? 16000 : null }) };
    },
  };
}
