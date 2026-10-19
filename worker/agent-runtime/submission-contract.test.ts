import { describe, expect, it } from 'vitest';
import { classifyRuntimeModelFailure } from './model-errors';
import {
  SubmissionIssues,
  SubmissionRejected,
  domainIssues,
  formatIssues,
  submissionFeedback,
} from './submission-contract';

describe('submission contract', () => {
  it('collects every issue instead of stopping at the first', () => {
    const issues = new SubmissionIssues()
      .format('unknown_strategy_keyword', 'sk-9 is not in the strategy', 'items[0]')
      .domain('requested_capacity_exceeded', 'The requested group capacity is exceeded', 'items[1]')
      .format('wrong_source_locale', 'locale must be en', 'items[2]');
    // Fail-fast validation reports one problem per rejection, so an Agent needs
    // one decision turn per defect to discover a set it could have had at once.
    expect(issues.list).toHaveLength(3);
    expect(formatIssues(issues.list).map((issue) => issue.code)).toEqual([
      'unknown_strategy_keyword', 'wrong_source_locale',
    ]);
    expect(domainIssues(issues.list).map((issue) => issue.code)).toEqual(['requested_capacity_exceeded']);
  });

  it('tells the model to repair a field when nothing about the judgment is wrong', () => {
    const feedback = submissionFeedback(new SubmissionIssues()
      .format('unverified_web_evidence', 'ref is not a returned url', 'evidence[0].ref').list);
    expect(feedback.accepted).toBe(false);
    expect(feedback.guidance).toContain('Repair only the fields named below');
    expect(feedback.guidance).not.toContain('Reconsider');
  });

  it('tells the model to reconsider only when the judgment itself must change', () => {
    const feedback = submissionFeedback(new SubmissionIssues()
      .format('wrong_source_locale', 'locale must be en')
      .domain('duplicate_submission_identity', 'Submission identity was already used').list);
    expect(feedback.guidance).toContain('Reconsider the judgment');
    expect(feedback.guidance).toContain('keep every part that passed');
  });

  it('accepts an empty issue set', () => {
    expect(submissionFeedback([])).toMatchObject({ accepted: true, issues: [] });
  });

  it('preserves the distinction between structural and domain contract issues', () => {
    const domainOnly = new SubmissionIssues().domain('requested_capacity_exceeded', 'Requested count exceeded');
    expect(() => domainOnly.throwIfFormat()).not.toThrow();
    const withFormat = new SubmissionIssues()
      .domain('requested_capacity_exceeded', 'Requested count exceeded')
      .format('wrong_source_locale', 'locale must be en');
    expect(() => withFormat.throwIfFormat()).toThrow(SubmissionRejected);
  });

  it('carries every issue in the thrown rejection, not just the format ones', () => {
    let thrown: unknown;
    try {
      new SubmissionIssues()
        .domain('requested_capacity_exceeded', 'Requested count exceeded')
        .format('wrong_source_locale', 'locale must be en')
        .throwIfFormat();
    } catch (error) { thrown = error; }
    expect((thrown as SubmissionRejected).issues).toHaveLength(2);
    expect((thrown as Error).message).toContain('[format:wrong_source_locale]');
    expect((thrown as Error).message).toContain('[domain:requested_capacity_exceeded]');
  });

  it('is classified by type, so quoted model text can never read as a transport failure', () => {
    const rejection = new SubmissionRejected([{
      code: 'unknown_strategy_keyword', severity: 'format',
      message: 'Topic decision references an unknown strategy keyword: how to fix a slow network connection',
    }]);
    expect(classifyRuntimeModelFailure(rejection).kind).toBe('invalid_output');
  });

  it('bounds feedback so it survives being stored and replayed as a tool result', () => {
    const issues = new SubmissionIssues();
    for (let index = 0; index < 40; index += 1) issues.domain(`domain_${index}`, 'x'.repeat(1400));
    issues.format('unverified_web_evidence', 'y'.repeat(1400));
    const feedback = submissionFeedback(issues.list);
    // An oversized feedback object is stored and replayed as a truncation
    // envelope that no longer parses as feedback, so the bound is structural.
    expect(feedback.issues.length).toBeLessThanOrEqual(21);
    expect(JSON.stringify(feedback).length).toBeLessThan(32_000);
    // Format issues come first: they are the ones repairable without rethinking.
    expect(feedback.issues[0].code).toBe('unverified_web_evidence');
    expect(feedback.issues.at(-1)?.code).toBe('additional_issues');
    expect(feedback.issues.at(-1)?.message).toContain('further issue');
  });
});
