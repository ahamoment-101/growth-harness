import { z } from 'zod';
import { RuntimeValidationError } from './model-errors';

/**
 * How an Agent's submission was rejected, and therefore what it costs to fix.
 *
 * `format` — reference and identity integrity the model can repair by editing
 * the named field: an id that is not in the allowed set, a value that was
 * rewritten when it had to be preserved, a citation that is not one of the
 * strings a tool returned. Nothing about the underlying judgment changes, so
 * these are repaired inside the decision turn by the model gateway and cost no
 * business turn.
 *
 * `domain` — the judgment itself has to change: the Agent chose work that is
 * already covered, duplicated existing content, exceeded requested capacity, or
 * failed a structural quality gate. Repairing these means reconsidering, so
 * they legitimately cost a decision turn.
 *
 * Getting this split wrong in either direction is expensive. Calling a domain
 * issue `format` makes the model rewrite the same rejected judgment inside one
 * turn until the attempt budget runs out; calling a format issue `domain` is
 * what burned four turns on a mis-typed evidence reference.
 */
export type SubmissionIssueSeverity = 'format' | 'domain';

export type SubmissionIssue = {
  code: string;
  severity: SubmissionIssueSeverity;
  message: string;
  path?: string;
};

export type SubmissionFeedback = {
  accepted: boolean;
  issues: SubmissionIssue[];
  guidance: string;
};

export const submissionIssueSchema = z.object({
  code: z.string().trim().min(1).max(100),
  severity: z.enum(['format', 'domain']),
  message: z.string().trim().min(1).max(1500),
  path: z.string().trim().max(300).optional(),
});

export const submissionFeedbackSchema = z.object({
  accepted: z.boolean(),
  issues: z.array(submissionIssueSchema).max(40),
  guidance: z.string().trim().min(1).max(1500),
});

/** A submission rejected by deterministic validation. Typed so classification
 * never mistakes the model-supplied text it quotes for a provider failure. */
export class SubmissionRejected extends RuntimeValidationError {
  readonly issues: SubmissionIssue[];

  constructor(issues: SubmissionIssue[]) {
    super(renderSubmissionIssues(issues));
    this.name = 'SubmissionRejected';
    this.issues = issues;
  }
}

export function renderSubmissionIssues(issues: SubmissionIssue[]): string {
  return issues
    .map((issue) => `[${issue.severity}:${issue.code}]${issue.path ? ` at ${issue.path}` : ''} ${issue.message}`)
    .join('\n');
}

export function formatIssues(issues: SubmissionIssue[]): SubmissionIssue[] {
  return issues.filter((issue) => issue.severity === 'format');
}

export function domainIssues(issues: SubmissionIssue[]): SubmissionIssue[] {
  return issues.filter((issue) => issue.severity === 'domain');
}

const ACCEPTED_GUIDANCE = 'The objective submission contract passed. Runtime may persist this outcome.';

/**
 * Feedback is serialised into a tool result and replayed from D1, where an
 * oversized value is wrapped as a truncation envelope that no longer parses as
 * feedback. Bounding it here keeps that impossible by construction rather than
 * by hoping the limits are generous enough. Format issues are kept first: they
 * are the ones the model can act on without rethinking.
 */
const MAX_REPORTED_ISSUES = 20;
const MAX_ISSUE_MESSAGE = 600;

function boundIssues(issues: SubmissionIssue[]): SubmissionIssue[] {
  const ordered = [...formatIssues(issues), ...domainIssues(issues)];
  const kept = ordered.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    ...issue,
    message: issue.message.length > MAX_ISSUE_MESSAGE
      ? `${issue.message.slice(0, MAX_ISSUE_MESSAGE)}…`
      : issue.message,
  }));
  if (ordered.length <= MAX_REPORTED_ISSUES) return kept;
  return [...kept, {
    code: 'additional_issues',
    severity: ordered[MAX_REPORTED_ISSUES].severity,
    message: `${ordered.length - MAX_REPORTED_ISSUES} further issue(s) of the same kinds were found and are not listed here. Fix the listed ones first.`,
  }];
}

/**
 * Derives guidance from what actually failed.
 *
 * The previous per-Agent strings told the model to "reconsider the whole
 * decision and revise the direction" for every rejection, including a single
 * mistyped field. The model duly rewrote an entire sound decision and left the
 * field wrong.
 */
export function submissionFeedback(issues: SubmissionIssue[]): SubmissionFeedback {
  if (!issues.length) return { accepted: true, issues: [], guidance: ACCEPTED_GUIDANCE };
  const hasDomain = issues.some((issue) => issue.severity === 'domain');
  return {
    accepted: false,
    issues: boundIssues(issues),
    guidance: hasDomain
      ? 'Reconsider the judgment where the domain issues below require it, and keep every part that passed. Repair the format issues exactly as stated without changing anything else.'
      : 'Repair only the fields named below. Keep every other value, and the decision itself, unchanged. Do not restate or rewrite the judgment.',
  };
}

/** Collects issues without stopping at the first one. Fail-fast validation can
 * only report one problem per rejection, so an Agent needs one decision turn
 * per defect to discover a set it could have been handed at once. */
export class SubmissionIssues {
  private readonly collected: SubmissionIssue[] = [];

  add(issue: SubmissionIssue): this {
    this.collected.push(issue);
    return this;
  }

  format(code: string, message: string, path?: string): this {
    return this.add({ code, severity: 'format', message, ...(path ? { path } : {}) });
  }

  domain(code: string, message: string, path?: string): this {
    return this.add({ code, severity: 'domain', message, ...(path ? { path } : {}) });
  }

  push(issues: SubmissionIssue[]): this {
    this.collected.push(...issues);
    return this;
  }

  get list(): SubmissionIssue[] { return [...this.collected]; }

  get length(): number { return this.collected.length; }

  /** Throws when any format issue is present, so the gateway repairs it inside
   * the decision turn. Domain issues alone are returned for the tool execution
   * path to report as an observation. */
  throwIfFormat(): void {
    const format = formatIssues(this.collected);
    if (format.length) throw new SubmissionRejected(this.collected);
  }
}
