// @ts-ignore Node-only test module.
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { sqliteTestBindings } from './sqlite-test-bindings';

it('binds D1 numbered parameters in SQL order on the supported Node 22 runtime', () => {
  const sqlite = new DatabaseSync(':memory:');
  const sql = "select ?3 as third, ?1 as first, ?2 as second, ?1 as repeated, '?4' as literal";
  expect({ ...sqlite.prepare(sql).get(...sqliteTestBindings(sql, ['one', 'two', 'three'])) })
    .toEqual({ third: 'three', first: 'one', second: 'two', repeated: 'one', literal: '?4' });
  expect(sqliteTestBindings('select ? as anonymous', ['value'])).toEqual(['value']);
  sqlite.close();
});
