import { normalizeTopicDecisionBranches, topicDecisionOutputSchema, type TopicDecisionOutput } from './topic-decision-contract';
import { SubmissionIssues, SubmissionRejected, submissionFeedback, type SubmissionIssue } from './submission-contract';
type WebEvidence = { ref?: string; url: string; title: string; content: string; query?: string };
function strategyKeywordMap(context: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const strategy = context.active_strategy && typeof context.active_strategy === 'object'
    ? context.active_strategy as Record<string, unknown>
    : {};
  const keywords = Array.isArray(strategy.keywords) ? strategy.keywords : [];
  return new Map(keywords.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const id = String(row.strategy_keyword_id || '');
    return id ? [[id, row] as const] : [];
  }));
}

export function resolveWebEvidenceRef(ref: string, evidence: WebEvidence[]): string | null {
  return evidence.find(item => item.ref === ref || item.url === ref)?.url || null;
}
export function normalizeTopicDecisionAgainstContext(output: TopicDecisionOutput, context: Record<string, unknown>, evidence: WebEvidence[] = []): TopicDecisionOutput {
  if (!output.group) return output;
  const keywords = strategyKeywordMap(context);
  return { ...output, group: { ...output.group, items: output.group.items.map(item => ({ ...item,
    keyword_id: String(keywords.get(item.strategy_keyword_id)?.keyword_id || item.keyword_id),
    evidence: item.evidence.map(source => source.source_type === 'web' ? { ...source, ref: resolveWebEvidenceRef(source.ref, evidence) || source.ref } : source),
  })) } };
}
function requestedConstraints(context: Record<string, unknown>): {
  count: number;
  sourceLocale: string;
  locales: Set<string>;
} {
  const value = context.run_constraints && typeof context.run_constraints === 'object'
    ? context.run_constraints as Record<string, unknown>
    : {};
  const count = Math.max(1, Math.min(20, Number(value.requested_count || 10)));
  const sourceLocale = String(value.source_locale || '').trim();
  const locales = new Set(Array.isArray(value.locales) ? value.locales.map(String) : []);
  return { count, sourceLocale, locales };
}

/** Validate identity, scope, evidence provenance and explicit requested capacity. */
export function topicDecisionIssues(
  output: TopicDecisionOutput,
  context: Record<string, unknown>,
  webEvidence: WebEvidence[] = [],
): SubmissionIssue[] {
  const issues = new SubmissionIssues();
  const parsed = topicDecisionOutputSchema.safeParse(output);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.format('schema', issue.message, issue.path.join('.') || undefined);
    }
    return issues.list;
  }
  const value = parsed.data;
  if (value.decision_type !== 'topic_group' || !value.group) return issues.list;
  const allowed = strategyKeywordMap(context);
  const constraints = requestedConstraints(context);
  const webUrls = new Set(webEvidence.map((entry) => entry.url));
  if (value.group.items.length > constraints.count) {
    issues.domain(
      'above_requested_capacity',
      `Topic group returned ${value.group.items.length} items, above the requested capacity ${constraints.count}`,
      'group.items',
    );
  }
  const seenTopicKeys = new Set<string>();
  value.group.items.forEach((item, index) => {
    const at = `group.items[${index}]`;
    const source = allowed.get(item.strategy_keyword_id);
    if (!source || String(source.keyword_id || '') !== item.keyword_id) {
      issues.format(
        'unknown_strategy_keyword',
        `Topic decision references an unknown strategy keyword: ${item.strategy_keyword_id}`,
        `${at}.strategy_keyword_id`,
      );
    }
    const topicKey = item.topic_key.trim().toLowerCase();
    if (seenTopicKeys.has(topicKey)) {
      issues.domain('repeated_topic_key', `Topic decision repeats topic key: ${item.topic_key}`, `${at}.topic_key`);
    }
    seenTopicKeys.add(topicKey);
    if (source && String(source.term || '').trim().toLowerCase() !== item.primary_keyword.trim().toLowerCase()) {
      issues.format(
        'rewritten_primary_keyword',
        `Topic decision changed the strategic keyword text: ${item.strategy_keyword_id}`,
        `${at}.primary_keyword`,
      );
    }
    if (constraints.locales.size && !constraints.locales.has(item.locale)) {
      issues.format('unrequested_locale', `Topic decision selected an unrequested locale: ${item.locale}`, `${at}.locale`);
    }
    if (constraints.sourceLocale && item.locale !== constraints.sourceLocale) {
      issues.format(
        'wrong_source_locale',
        `Topic decision must create source content in the site source locale: ${constraints.sourceLocale}`,
        `${at}.locale`,
      );
    }
    if (source && String(source.locale || '') && String(source.locale) !== item.locale) {
      issues.format('locale_drift', `Topic decision changed the strategic keyword locale: ${item.strategy_keyword_id}`, `${at}.locale`);
    }
    item.evidence.forEach((evidence, evidenceIndex) => {
      if (evidence.source_type === 'web' && !webUrls.has(evidence.ref)) {
        issues.format(
          'unverified_web_evidence',
          `Topic decision cites Web evidence that was not returned by topic_search_web: ${evidence.ref}`,
          `${at}.evidence[${evidenceIndex}].ref`,
        );
      }
    });
  });
  return issues.list;
}

/**
 * Throwing form kept for callers that want one gate: raises `SubmissionRejected`
 * carrying every issue, so a rejection still reports the whole set at once.
 */
export function validateTopicDecisionAgainstContext(
  output: TopicDecisionOutput,
  context: Record<string, unknown>,
  webEvidence: WebEvidence[] = [],
): TopicDecisionOutput {
  const parsed = topicDecisionOutputSchema.parse(output);
  const issues = topicDecisionIssues(parsed, context, webEvidence);
  if (issues.length) throw new SubmissionRejected(issues);
  return parsed;
}

export function topicDecisionSubmissionFeedback(input: {
  decision: TopicDecisionOutput;
  context: Record<string, unknown>;
  webEvidence: WebEvidence[];
}): { feedback: ReturnType<typeof submissionFeedback> & { decision_type?: TopicDecisionOutput['decision_type'] }; output?: TopicDecisionOutput } {
  const parsed = topicDecisionOutputSchema.safeParse(normalizeTopicDecisionBranches(input.decision));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue): SubmissionIssue => ({
      code: 'schema', severity: 'format', message: issue.message, path: issue.path.join('.') || undefined,
    }));
    return { feedback: submissionFeedback(issues) };
  }
  const normalized = normalizeTopicDecisionAgainstContext(parsed.data, input.context, input.webEvidence);
  const issues = topicDecisionIssues(normalized, input.context, input.webEvidence);
  if (issues.length) return { feedback: submissionFeedback(issues) };
  return {
    output: normalized,
    feedback: { ...submissionFeedback([]), decision_type: normalized.decision_type },
  };
}

