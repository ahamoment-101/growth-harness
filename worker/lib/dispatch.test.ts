import { describe, expect, it, vi } from 'vitest';
import { startPublish } from './dispatch';

function envWithTransition(
  changes: number,
  create = vi.fn(async () => ({ id: 'workflow-1' })),
  locale = 'en',
) {
  const statements: string[] = [];
  const db = {
    prepare: (sql: string) => {
      statements.push(sql);
      const statement = {
        bind: (..._values: unknown[]) => statement,
        first: async () => sql.includes('from jobs')
          ? {
              id: 'job-1',
              site_id: 'site-1',
              status: 'awaiting_review',
              versions_json: JSON.stringify([{ locale, slug: 'hello', title: 'Hello', excerpt: 'Ex', content: 'Body' }]),
            }
          : {
              id: 'site-1',
              source_locale: 'en',
              translate_locales_json: '[]',
              locale_policy_json: '',
            },
        run: async () => ({ meta: { changes: sql.includes("status = 'publishing'") ? changes : 1 } }),
      };
      return statement;
    },
  };
  return { env: { DB: db, PUBLISH_WORKFLOW: { create } } as unknown as Env, create, statements };
}

describe('publish dispatch', () => {
  it('allows only one transition from human review into publishing', async () => {
    const fixture = envWithTransition(0);
    await expect(startPublish(fixture.env, 'job-1')).rejects.toThrow('no longer awaiting_review');
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('creates the publish workflow after the guarded state transition', async () => {
    const fixture = envWithTransition(1);
    await startPublish(fixture.env, 'job-1');
    expect(fixture.create).toHaveBeenCalledWith({ params: { jobId: 'job-1' } });
  });

  it('rejects an invalid content locale before changing the job state', async () => {
    const fixture = envWithTransition(1, vi.fn(async () => ({ id: 'workflow-1' })), 'not_a_locale');
    await expect(startPublish(fixture.env, 'job-1')).rejects.toThrow('invalid locale code');
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.statements.some((sql) => sql.includes("status = 'publishing'"))).toBe(false);
  });
});
