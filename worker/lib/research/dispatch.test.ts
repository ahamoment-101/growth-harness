// @ts-ignore Node test fixture.
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../agent-runtime/run-service', () => ({ startRuntimeRun: vi.fn() }));
vi.mock('../../db', async importOriginal => ({ ...await importOriginal<object>(), getSite: vi.fn(async (_db: unknown, id: string) => id === 's' ? { id: 's', workspace_id: 'w', source_locale: 'en', translate_locales_json: '["pt-BR"]' } : null) }));
import { startRuntimeRun } from '../../agent-runtime/run-service';
import { dispatchTopicResearchRequests } from './dispatch';
import { undispatchedTopicResearchRequest, unfinishedStrategyTask } from '../../agent-runtime/topic-decision-store';

let sqlite: DatabaseSync;
function database() {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`create table agent_runs(id text,workspace_id text,site_id text,agent_id text,agent_instance_id text,status text,created_at text);
    create table agent_tasks(id text,status text,active_run_id text default '',parent_task_id text default '');
    create table seo_strategy_runs(id text,site_id text,source_locale text,status text,started_at text);
    create table topic_decision_results(id text,workspace_id text,site_id text,run_id text,status text,rationale text,research_request_json text,
      scope_locale text,scope_market text,created_at text,updated_at text,research_run_id text not null default '',research_dispatch_error text not null default '');`);
  return { prepare(sql: string) { let values: unknown[] = []; return { bind(...args: unknown[]) { values = args; return this; },
    async first() { return sqlite.prepare(sql).get(...values as never[]) || null; }, async all() { return { results: sqlite.prepare(sql).all(...values as never[]) }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values as never[]).changes) } }; } }; } } as unknown as D1Database;
}
const request = (id: string, locale = 'en', site = 's') => sqlite.prepare(`insert into topic_decision_results(id,workspace_id,site_id,run_id,status,rationale,research_request_json,scope_locale,scope_market,created_at,updated_at)
  values(?,'w',?,?,'research_needed','Library exhausted',?,?, 'global',?,'')`).run(id, site, `topic-${id}`, JSON.stringify({ gap: 'No search expressions for Slack messages', unknown: ['wording'] }), locale, id);
const row = (id: string) => sqlite.prepare('select research_run_id,research_dispatch_error from topic_decision_results where id=?').get(id);

beforeEach(() => vi.mocked(startRuntimeRun).mockReset());

it('finds unfinished strategy tasks of the language, including paused ones, and releases completed, cancelled or failed ones', async () => {
  const db = database();
  const strategy = (id: string, runStatus: string, taskStatus: string | null, locale = 'en') => {
    sqlite.prepare("insert into agent_runs values(?,'w','s','strategy_research',?,?,?)").run(id, `strategy:${locale}`, runStatus, id);
    if (taskStatus) sqlite.prepare('insert into agent_tasks(id,status) values(?,?)').run(id, taskStatus);
  };
  for (const [index, status] of ['completed', 'cancelled', 'failed'].entries()) strategy(`done-${index}`, 'succeeded', status);
  strategy('other-language', 'running', 'running', 'pt-BR');
  expect(await unfinishedStrategyTask(db, 'w', 's', 'en')).toBeNull();
  strategy('paused', 'waiting_for_input', 'paused');
  expect(await unfinishedStrategyTask(db, 'w', 's', 'en')).toEqual({ id: 'paused', status: 'paused' });
  sqlite.exec("update agent_tasks set status='cancelled' where id='paused'; insert into agent_runs values('queued','w','s','strategy_research','strategy:en','queued','z')");
  expect(await unfinishedStrategyTask(db, 'w', 's', 'en')).toEqual({ id: 'queued', status: 'queued' });
});

it('starts strategy research once per request with the request as data and keeps busy languages pending', async () => {
  const db = database();
  const env = { DB: db, AGENT_RUNTIME_ENABLED: 'true' } as unknown as Env;
  request('r1'); request('r2', 'pt-BR'); request('r3', 'de'); request('r4', 'en', 'gone');
  sqlite.prepare("insert into agent_runs values('busy','w','s','strategy_research','strategy:pt-BR','running','a')").run();
  sqlite.prepare("insert into agent_tasks(id,status) values('busy','running')").run();
  vi.mocked(startRuntimeRun).mockImplementation(async (...args: any[]) => ({ id: args[1]?.runId }) as never);
  expect(await undispatchedTopicResearchRequest(db, 'w', 's', 'en')).toEqual({ id: 'r1' });

  await dispatchTopicResearchRequests(env);
  expect(vi.mocked(startRuntimeRun)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(startRuntimeRun).mock.calls[0][1]).toMatchObject({ agentId: 'strategy_research', instanceId: 'strategy:en', runId: 'topic-research-r1',
    summary: { locale: 'en', request: { requester: { type: 'agent', agent_id: 'topic_decision', task_id: 'topic-r1', research_request_id: 'r1' },
      message: expect.stringContaining('No search expressions for Slack messages'), context: { unknown: ['wording'] } } } });
  expect(row('r1')).toEqual({ research_run_id: 'topic-research-r1', research_dispatch_error: '' });
  expect(row('r2')).toEqual({ research_run_id: '', research_dispatch_error: '' });
  expect(row('r3')).toMatchObject({ research_run_id: '', research_dispatch_error: expect.stringContaining('language') });
  expect(row('r4')).toMatchObject({ research_run_id: '', research_dispatch_error: 'site not found' });
  expect(await undispatchedTopicResearchRequest(db, 'w', 's', 'en')).toBeNull();

  vi.mocked(startRuntimeRun).mockRejectedValueOnce(new Error('This agent already has a set of Tasks running'));
  sqlite.exec("update agent_tasks set status='completed' where id='busy'");
  await dispatchTopicResearchRequests(env);
  expect(row('r2')).toEqual({ research_run_id: '', research_dispatch_error: '' });
  await dispatchTopicResearchRequests(env);
  expect(row('r2')).toEqual({ research_run_id: 'topic-research-r2', research_dispatch_error: '' });
  expect(vi.mocked(startRuntimeRun)).toHaveBeenCalledTimes(3);
});
