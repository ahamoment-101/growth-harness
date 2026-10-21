import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unlistedMigrations } from './check-changelog.mjs';

test('requires migrations after the baseline to be named in the changelog', () => {
  const files = ['0081_password_auth.sql', '0082_new_table.sql', '0083_drop_column.sql', 'README.md'];
  assert.deepEqual(unlistedMigrations(files, '- `0082_new_table.sql` adds a table.'), ['0083_drop_column.sql']);
  assert.deepEqual(unlistedMigrations(files, '0082_new_table.sql 0083_drop_column.sql'), []);
});

test('does not require baseline migrations to be listed individually', () => {
  assert.deepEqual(unlistedMigrations(['0001_init.sql', '0081_password_auth.sql'], ''), []);
});
