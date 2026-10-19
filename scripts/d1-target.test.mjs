import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { configuredD1Target, parseD1Options } from './d1-target.mjs';

const config = { d1_databases: [{ binding: 'OTHER', database_name: 'unrelated' }, { binding: 'DB', database_name: 'renamed-database' }],
  env: { staging: { d1_databases: [{ binding: 'DB', database_name: 'staging-database' }] } } };

test('uses the configured DB binding and requires an explicit local or remote target', () => {
  assert.deepEqual(configuredD1Target(config, parseD1Options(['--local'])), ['renamed-database', '--config', resolve('wrangler.jsonc'), '--local']);
  assert.throws(() => parseD1Options([]), /exactly one/);
  assert.throws(() => parseD1Options(['--remote', '--local']), /exactly one/);
});

test('honors config, environment and explicit database without falling back to production', () => {
  const options = parseD1Options(['--remote', '--config', 'install/wrangler.jsonc', '--env', 'staging']);
  assert.deepEqual(configuredD1Target(config, options), ['staging-database', '--config', resolve('install/wrangler.jsonc'), '--remote', '--env', 'staging']);
  assert.equal(configuredD1Target(config, parseD1Options(['--local', '--database', 'explicit-database']))[0], 'explicit-database');
  assert.throws(() => configuredD1Target(config, parseD1Options(['--local', '--env', 'missing'])), /not configured/);
  assert.throws(() => configuredD1Target({ env: { staging: {} }, ...{ d1_databases: config.d1_databases } }, options), /DB D1 binding/);
});

test('rejects unknown or incomplete CLI options before running Wrangler', () => {
  assert.throws(() => parseD1Options(['--local', '--config']), /needs a value/);
  assert.throws(() => parseD1Options(['--local', '--databse', 'typo']), /Unknown argument/);
});
