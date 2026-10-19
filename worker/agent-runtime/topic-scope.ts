import { z } from 'zod';
import { scopeSchema } from '../keyword-library/contracts';

export const topicScopeSchema = scopeSchema.pick({ locale: true });
export type TopicScope = z.infer<typeof topicScopeSchema>;
export function topicScope(summary: unknown): TopicScope | null {
  const value = typeof summary === 'string' ? JSON.parse(summary) : summary;
  if (!value || typeof value !== 'object' || !('scope' in value)) return null;
  return topicScopeSchema.parse((value as { scope: unknown }).scope);
}
export function topicInstance(scope: TopicScope): string {
  // Hex encoding preserves the entire scope without ambiguous separators or Runtime's reserved --.
  return `topic:${Array.from(new TextEncoder().encode(JSON.stringify([scope.locale])), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export function scopedTopicSummary(body: Record<string, unknown>) {
  const scope = topicScopeSchema.parse(body.scope || { locale: body.locale });
  const groupSize = z.number().int().min(1).max(20).parse(Number(body.group_size || 10));
  return { runtime: 'topic_decision_scoped_v3', group_size: groupSize, locales: [scope.locale], scope };
}
