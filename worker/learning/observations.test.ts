import { afterEach, describe, expect, it, vi } from 'vitest';
import { schemaTestDb } from '../lib/schema-test-db';
import { encryptToken, gscSearchAnalyticsAll } from '../lib/gsc';
import {
  collectObservation,
  collectDueLearningOutcomes,
  emitPracticeOutcome,
  gscDay,
} from './observations';
import type { RuntimeAgentEnv } from '../agent-runtime/env';

afterEach(() => vi.unstubAllGlobals());
describe('learning observation sources', () => {
  it('does not let a slower concurrent collection overwrite a committed outcome', async () => {
    const f = schemaTestDb(),
      key = 'ab'.repeat(32);
    f.insert('sites', {
      id: 's',
      workspace_id: 'primary-workspace',
      domain: 'example.com',
      gsc_refresh_token_cipher: await encryptToken('synthetic', key),
    });
    f.insert('learning_records', {
      id: 'r',
      workspace_id: 'primary-workspace',
      site_id: 's',
      origin_task_id: 't',
      data_json: '{}',
    });
    f.insert('learning_observations', {
      id: 'o',
      record_id: 'r',
      job_id: 'j',
      artifact_id: 'a',
      url: 'https://example.com/page',
      start_date: '2026-10-01',
      end_date: '2026-10-01',
      result_json: 'null',
      available_at: '2000-01-01T00:00:00Z',
    });
    let release!: (value: Response) => void,
      started!: () => void,
      calls = 0;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const row = (clicks: number) =>
      Response.json({
        rows: [
          {
            keys: ['2026-10-01'],
            clicks,
            impressions: 100,
            ctr: clicks / 100,
            position: 3,
          },
        ],
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('oauth2'))
          return Response.json({ access_token: 'local', expires_in: 3600 });
        if (++calls === 1) {
          started();
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return row(3);
      }),
    );
    const env = {
      DB: f.db,
      GOOGLE_CLIENT_ID: 'local',
      GOOGLE_CLIENT_SECRET: 'local',
      GSC_TOKEN_CIPHER_KEY: key,
    } as RuntimeAgentEnv & {
      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
      GSC_TOKEN_CIPHER_KEY: string;
    };
    const slow = collectDueLearningOutcomes(
      env,
      new Date('2026-10-23T00:00:00Z'),
    );
    await firstStarted;
    await collectDueLearningOutcomes(env, new Date('2026-10-23T00:00:00Z'));
    release(row(1));
    await slow;
    const stored = f.sqlite
      .prepare('select result_json from learning_observations')
      .get() as { result_json: string };
    expect(JSON.parse(stored.result_json).values.clicks.value).toBe(3);
    expect(
      f.sqlite.prepare('select count(*) n from learning_evidence').get(),
    ).toEqual({ n: 1 });
  });
  it('uses exact page and inclusive dates and preserves provisional metadata', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        rows: [],
        metadata: { first_incomplete_date: '2026-10-22' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const result = await gscSearchAnalyticsAll({
      siteUrl: 'https://example.com/',
      accessToken: 'local-test',
      startDate: '2026-10-01',
      endDate: '2026-10-22',
      dimensions: ['date'],
      pageUrl: 'https://example.com/specific',
      dataState: 'all',
    });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
      startDate: '2026-10-01',
      endDate: '2026-10-22',
      dataState: 'all',
      dimensionFilterGroups: [
        {
          filters: [
            {
              dimension: 'page',
              operator: 'equals',
              expression: 'https://example.com/specific',
            },
          ],
        },
      ],
    });
    expect(result.metadata?.first_incomplete_date).toBe('2026-10-22');
  });
  it('does not turn empty or provisional rows into zero or a complete outcome', async () => {
    const f = schemaTestDb(),
      key = 'ab'.repeat(32),
      cipher = await encryptToken('synthetic', key);
    f.insert('sites', {
      id: 's',
      workspace_id: 'primary-workspace',
      domain: 'example.com',
      gsc_refresh_token_cipher: cipher,
    });
    let response: unknown = { rows: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json(
          url.includes('oauth2')
            ? { access_token: 'local', expires_in: 3600 }
            : response,
        ),
      ),
    );
    const env = {
      DB: f.db,
      GOOGLE_CLIENT_ID: 'local',
      GOOGLE_CLIENT_SECRET: 'local',
      GSC_TOKEN_CIPHER_KEY: key,
    } as RuntimeAgentEnv & {
      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
      GSC_TOKEN_CIPHER_KEY: string;
    };
    const row = {
      id: 'o',
      record_id: 'r',
      job_id: 'j',
      artifact_id: 'a',
      url: 'https://example.com/page',
      start_date: '2026-10-01',
      end_date: '2026-10-01',
      status: 'pending',
      workspace_id: 'primary-workspace',
      site_id: 's',
      result_json: 'null',
    };
    expect(await collectObservation(env, row)).toMatchObject({
      complete: false,
      values: {},
      start_date: '2026-10-01',
      end_date: '2026-10-01',
    });
    response = {
      rows: [
        {
          keys: ['2026-10-01'],
          clicks: 0,
          impressions: 20,
          ctr: 0,
          position: 4,
        },
      ],
      metadata: { first_incomplete_date: '2026-10-01' },
    };
    expect(await collectObservation(env, row)).toMatchObject({
      complete: false,
      values: { clicks: { value: 0, unit: 'count' } },
    });
    response = {
      rows: [
        {
          keys: ['2026-10-01'],
          clicks: 0,
          impressions: 20,
          ctr: 0,
          position: 4,
        },
      ],
    };
    expect(await collectObservation(env, row)).toMatchObject({
      complete: true,
      values: { clicks: { value: 0, unit: 'count' } },
    });
    expect(gscDay(new Date('2026-10-01T00:30:00Z'))).toBe('2026-09-30');
  });
  it('deduplicates unchanged snapshots but preserves corrections that return to a prior value', async () => {
    const f = schemaTestDb(),
      scope = { workspaceId: 'primary-workspace', siteId: 's' };
    f.insert('sites', { id: 's', workspace_id: scope.workspaceId });
    f.insert('learning_records', {
      id: 'r',
      workspace_id: scope.workspaceId,
      site_id: 's',
      origin_task_id: 't',
      data_json: '{}',
    });
    f.insert('learning_observations', {
      id: 'o',
      record_id: 'r',
      job_id: 'j',
      artifact_id: 'a',
      result_json: 'null',
    });
    const emit = async (clicks: number, at: string) => {
      f.sqlite
        .prepare('update learning_observations set result_json=? where id=?')
        .run(
          JSON.stringify({
            complete: true,
            collected_at: at,
            values: {
              clicks: { value: clicks, unit: 'count' },
              impressions: { value: 100, unit: 'count' },
              position: { value: 5, unit: 'rank' },
            },
          }),
          'o',
        );
      await emitPracticeOutcome({ DB: f.db } as RuntimeAgentEnv, scope, 'r');
    };
    await emit(10, '2026-10-01T00:00:00.000Z');
    await emit(10, '2026-10-02T00:00:00.000Z');
    expect(
      f.sqlite.prepare('select count(*) n from learning_evidence').get(),
    ).toEqual({ n: 1 });
    await emit(2, '2026-10-03T00:00:00.000Z');
    await emit(10, '2026-10-04T00:00:00.000Z');
    expect(
      f.sqlite.prepare('select count(*) n from learning_evidence').get(),
    ).toEqual({ n: 3 });
  });
});
