// @ts-ignore Node exposes node:sqlite at runtime across the supported local test versions.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { persistRuntimeModelDecision, readRuntimeModelResult, decisionPurpose, parseDecisionPurpose } from './observability';

/**
 * Decision caching across execution scopes.
 *
 * An Agent that runs one decision loop per locale restarts the turn counter for
 * every locale. The cache used to be keyed on (run_id, turn) alone, so the
 * second locale replayed the first locale's actions without ever calling the
 * model — and, because those actions carried the first locale's identity, could
 * never pass its own validation.
 */
function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    create table agent_runs (
      id text primary key, updated_at text not null default '',
      input_tokens integer not null default 0, output_tokens integer not null default 0,
      cost_usd real not null default 0
    );
    create table agent_model_calls (
      id text primary key, run_id text not null, turn integer not null,
      provider text not null, model text not null, status text not null,
      input_tokens integer not null default 0, output_tokens integer not null default 0,
      cost_usd real not null default 0, duration_ms integer not null default 0,
      request_id text not null default '', error text not null default '',
      created_at text not null, result_json text not null default '{}',
      unique (run_id, turn)
    );
    create table agent_model_attempts (
      id text primary key, run_id text not null, purpose text not null,
      decision_turn integer not null, attempt integer not null,
      input_tokens integer not null default 0, output_tokens integer not null default 0,
      cost_usd real not null default 0,
      unique (run_id, purpose, decision_turn, attempt)
    );
    create table agent_decision_results (
      id text primary key, run_id text not null, execution_scope text not null default '',
      turn integer not null, provider text not null, model text not null,
      result_json text not null default '{}', created_at text not null, provider_attempts integer, structural_repairs integer,
      unique (run_id, execution_scope, turn)
    );
    insert into agent_runs (id) values ('run-1');
  `);
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    return {
      bind: (...next: unknown[]) => {
        values = next;
        return {
          first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null,
          all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
          run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values as never[]).changes } }),
        };
      },
    };
  };
  return { prepare, batch: async (statements: Array<{run(): Promise<unknown>}>) => Promise.all(statements.map(statement => statement.run())) } as unknown as D1Database;
}

describe('decision caching across execution scopes', () => {
  it('keeps one scope from replaying another scope decision at the same turn', async () => {
    const db = sqliteD1();
    await persistRuntimeModelDecision(db, {
      runId: 'run-1', turn: 1, provider: 'fixture', model: 'm',
      executionScope: 'en', result: { name: 'submit_topic_decision', locale: 'en' },
    });

    // Same Run, same turn number, different locale: nothing is cached yet, so
    // the caller must actually decide instead of inheriting English.
    expect(await readRuntimeModelResult(db, 'run-1', 1, 'pt-BR')).toBeNull();
    expect(await readRuntimeModelResult(db, 'run-1', 1, 'en')).toEqual({
      name: 'submit_topic_decision', locale: 'en',
    });

    await persistRuntimeModelDecision(db, {
      runId: 'run-1', turn: 1, provider: 'fixture', model: 'm',
      executionScope: 'pt-BR', result: { name: 'submit_topic_decision', locale: 'pt-BR' },
    });
    expect(await readRuntimeModelResult(db, 'run-1', 1, 'en')).toEqual({
      name: 'submit_topic_decision', locale: 'en',
    });
    expect(await readRuntimeModelResult(db, 'run-1', 1, 'pt-BR')).toEqual({
      name: 'submit_topic_decision', locale: 'pt-BR',
    });
  });

  it('replays an unscoped decision, including one written by an older Worker', async () => {
    const db = sqliteD1();
    await persistRuntimeModelDecision(db, {
      runId: 'run-1', turn: 2, provider: 'fixture', model: 'm', result: { name: 'defer' },
    });
    expect(await readRuntimeModelResult(db, 'run-1', 2)).toEqual({ name: 'defer' });
    // Written to the legacy table too, so rolling back to a Worker that only
    // knows agent_model_calls can still replay an in-flight Run.
    const legacy = await db.prepare('select result_json from agent_model_calls where run_id = ? and turn = ?')
      .bind('run-1', 2).first<{ result_json: string }>();
    expect(JSON.parse(String(legacy?.result_json))).toEqual({ name: 'defer' });
  });

  it('never writes a scoped decision into the legacy single-turn table', async () => {
    const db = sqliteD1();
    await persistRuntimeModelDecision(db, {
      runId: 'run-1', turn: 1, provider: 'fixture', model: 'm', executionScope: 'en', result: { name: 'a' },
    });
    await persistRuntimeModelDecision(db, {
      runId: 'run-1', turn: 1, provider: 'fixture', model: 'm', executionScope: 'pt-BR', result: { name: 'b' },
    });
    const legacy = await db.prepare('select count(*) as rows from agent_model_calls where run_id = ?')
      .bind('run-1').first<{ rows: number }>();
    // The legacy unique key is (run_id, turn); two scopes would overwrite each
    // other there, which is exactly the collision being fixed.
    expect(Number(legacy?.rows || 0)).toBe(0);
  });

  it('separates attempt traces per scope so the model-call budget counts them all', () => {
    expect(decisionPurpose('', 'decision')).toBe('decision');
    expect(decisionPurpose('pt-BR')).toBe('decision@pt-BR');
    expect(decisionPurpose('en', 'compaction')).toBe('compaction@en');
    expect(parseDecisionPurpose('decision@pt-BR')).toEqual({ purpose: 'decision', executionScope: 'pt-BR' });
    expect(parseDecisionPurpose('decision')).toEqual({ purpose: 'decision', executionScope: '' });
    // Distinct purposes mean two scopes at the same turn produce two attempt
    // rows instead of overwriting one, so assertModelCallCapacity sees both.
    expect(decisionPurpose('en')).not.toBe(decisionPurpose('pt-BR'));
  });
});
