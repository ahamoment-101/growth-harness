// Real local Wrangler/D1 and installation commands. No remote resources or provider requests.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readWrangler, readVars } from './configuration.ts';
import { fixtureModelRegistry } from './runtime-fixture-capabilities.mjs';
import { verifyPassword } from '../worker/lib/auth/password.ts';

const root = process.cwd();
const directory = await mkdtemp(join(tmpdir(), 'blog-agent-installation-'));
const configPath = join(directory, 'wrangler.jsonc');
const config = readWrangler();
config.main = resolve(root, 'worker/index.ts');
config.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000';
config.d1_databases[0].migrations_dir = resolve(root, 'migrations');
await writeFile(configPath, JSON.stringify(config));
await writeFile(join(directory, '.dev.vars'), 'AUTH_LOGIN_METHODS=password\nMODEL_API_KEY=installation-preservation-fixture\nMODEL_REGISTRY=' + fixtureModelRegistry + '\n');
function run(script, args = [], input) {
  const result = spawnSync(process.execPath, [resolve(root, script), ...args], { cwd: root, encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${script} failed: ${result.error || (result.stderr || result.stdout).slice(-3000)}`);
  return result.stdout;
}
const deployGate = spawnSync(process.execPath, ['scripts/deploy-check.ts', '--config', configPath], { cwd: root, encoding: 'utf8' });
assert.equal(deployGate.status, 1);
assert.ok(deployGate.stderr.includes('local placeholder cannot be deployed'));
const wrangler = (args) => JSON.parse(run('node_modules/wrangler/bin/wrangler.js', ['d1', 'execute', config.d1_databases[0].database_name, '--config', configPath, '--local', '--json', ...args]));
try {
  run('scripts/setup.ts', ['--directory', directory, '--local']);
  const first = readVars(join(directory, '.dev.vars'));
  assert.ok(first.AUTH_SETUP_TOKEN.length >= 32);
  assert.equal(first.MODEL_API_KEY, 'installation-preservation-fixture');
  run('scripts/setup.ts', ['--directory', directory, '--local']);
  assert.deepEqual(readVars(join(directory, '.dev.vars')), first, 'Setup must not rotate secrets on replay');
  run('scripts/config-check.ts', ['--config', configPath, '--require-models']);
  const migrations = wrangler(['--command', 'select count(*) as count from d1_migrations'])[0].results[0].count;
  assert.equal(migrations, 81);
  wrangler(['--command', `insert into app_users(id,google_sub,email,display_name,created_at,last_login_at) values('owner','original-google','owner@example.invalid','Owner',datetime('now'),datetime('now'));
    update workspaces set owner_user_id='owner' where id='primary-workspace';
    insert into auth_sessions(id,token_hash,user_id,workspace_id,expires_at,last_seen_at,created_at) values('old-session','old-token','owner','primary-workspace','2099','2026','2026');`]);
  assert.equal(wrangler(['--command', "select owner_user_id from workspaces where id='primary-workspace'"])[0].results[0].owner_user_id, 'owner');
  run('scripts/auth-reset.ts', ['--config', configPath, '--local'], JSON.stringify({ email: 'owner@example.invalid', password: 'offline-reset-test-password' }));
  const credential = wrangler(['--command', "select password_hash from auth_password_credentials where user_id='owner'"])[0].results[0];
  assert.ok(await verifyPassword('offline-reset-test-password', credential.password_hash));
  assert.ok(wrangler(['--command', "select revoked_at from auth_sessions where id='old-session'"])[0].results[0].revoked_at);
  assert.equal(wrangler(['--command', 'select count(*) as count from app_users'])[0].results[0].count, 1);
  await writeFile(join(directory, '.dev.vars'), 'AUTH_LOGIN_METHODS=password,google\nAUTH_GOOGLE_CLIENT_SECRET=configuration-value-must-not-be-printed\n');
  const invalid = spawnSync(process.execPath, ['scripts/config-check.ts', '--config', configPath], { cwd: root, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.ok(invalid.stderr.includes('AUTH_GOOGLE_CLIENT_ID'));
  assert.ok(!invalid.stderr.includes('configuration-value-must-not-be-printed'));
  console.log(JSON.stringify({ verified: 'setup idempotency, local D1 migrations, selected-model keys, developer configuration errors and actual offline password reset', migrations, remoteEffects: false }));
} finally { await rm(directory, { recursive: true, force: true }); }
