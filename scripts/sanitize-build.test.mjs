import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./sanitize-build.mjs', import.meta.url));
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'build-sanitizer-'));
  mkdirSync(join(root, 'dist', 'renamed_worker'), { recursive: true });
  try { run(root, () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' })); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('allows documented public settings and removes preview credentials for any Worker name', () => fixture((root, check) => {
  writeFileSync(join(root, '.dev.vars'), 'AUTH_LOGIN_METHODS=password,google\nDATAFORSEO_LOGIN=operator@example.invalid\nCLOUDFLARE_WORKER_NAME=renamed_worker\nMODEL_API_KEY=synthetic-private-test-key\n');
  writeFileSync(join(root, 'dist/renamed_worker/.dev.vars'), 'MODEL_API_KEY=synthetic-private-test-key');
  writeFileSync(join(root, 'dist/renamed_worker/wrangler.json'), JSON.stringify({ vars: { AUTH_LOGIN_METHODS: 'password,google', DATAFORSEO_LOGIN: 'operator@example.invalid', CLOUDFLARE_WORKER_NAME: 'renamed_worker' } }));
  assert.equal(check().status, 0);
  assert.equal(existsSync(join(root, 'dist/renamed_worker/.dev.vars')), false);
}));

test('rejects a credential even when it was also copied into the source config', () => fixture((root, check) => {
  const value = 'synthetic-private-test-key';
  writeFileSync(join(root, '.dev.vars'), `MODEL_API_KEY="${value}"\n`);
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ vars: { MODEL_API_KEY: value } }));
  writeFileSync(join(root, 'dist/renamed_worker/index.js'), value);
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MODEL_API_KEY/);
  assert.equal(result.stderr.includes(value), false);
}));

test('rejects environment files in the distributable output', () => fixture((root, check) => {
  writeFileSync(join(root, 'dist/.env.production'), 'PRIVATE_SETTING=synthetic');
  assert.notEqual(check().status, 0);
}));


test('rejects output directory links before deleting any external preview environment file', () => fixture((root, check) => {
  const outside = join(root, 'external');
  mkdirSync(outside);
  writeFileSync(join(outside, '.dev.vars'), 'synthetic-outside-sentinel');
  symlinkSync(outside, join(root, 'dist', 'external-folder'), 'dir');
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic links/);
  assert.equal(readFileSync(join(outside, '.dev.vars'), 'utf8'), 'synthetic-outside-sentinel');
}));

test('rejects a symbolic output root and dangling or file links', () => fixture((root, check) => {
  const outside = join(root, 'external');
  mkdirSync(outside);
  writeFileSync(join(outside, '.dev.vars'), 'synthetic-outside-sentinel');
  rmSync(join(root, 'dist'), { recursive: true });
  symlinkSync(outside, join(root, 'dist'), 'dir');
  assert.notEqual(check().status, 0);
  assert.equal(readFileSync(join(outside, '.dev.vars'), 'utf8'), 'synthetic-outside-sentinel');
  rmSync(join(root, 'dist'));
  mkdirSync(join(root, 'dist'));
  symlinkSync(join(outside, '.dev.vars'), join(root, 'dist', '.dev.vars'));
  assert.notEqual(check().status, 0);
  assert.equal(readFileSync(join(outside, '.dev.vars'), 'utf8'), 'synthetic-outside-sentinel');
  rmSync(join(root, 'dist', '.dev.vars'));
  symlinkSync(join(outside, 'not-created'), join(root, 'dist', 'dangling'));
  assert.notEqual(check().status, 0);
}));
