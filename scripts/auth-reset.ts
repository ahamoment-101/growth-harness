import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { readWrangler } from './configuration.ts';
import { hashPassword, normalizeLoginEmail } from '../worker/lib/auth/password.ts';

const args = process.argv.slice(2);
if (args.includes('--local') === args.includes('--remote')) throw new Error('Choose exactly one: --local or --remote');
const configPath = args.includes('--config') ? resolve(args[args.indexOf('--config') + 1]) : resolve('wrangler.jsonc');
const config = readWrangler(configPath);
let email: string;
let password: string;
if (!process.stdin.isTTY) {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.length > 8192) throw new Error('Input too large');
  }
  const input = JSON.parse(data);
  email = normalizeLoginEmail(input.email); password = input.password;
} else {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  email = normalizeLoginEmail(await prompt.question('Existing administrator email: ')); prompt.close();
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const hidden = createInterface({ input: process.stdin, output: silent, terminal: true });
  process.stderr.write('New password (at least 12 characters; hidden): ');
  password = await hidden.question(''); hidden.close(); process.stderr.write('\n');
}
const passwordHash = await hashPassword(password);
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const at = new Date().toISOString();
const sql = `insert into auth_password_credentials(user_id,password_hash,updated_at)
  select u.id,${quote(passwordHash)},${quote(at)} from app_users u join workspaces w on w.owner_user_id=u.id
  where w.id='primary-workspace' and u.email=${quote(email)}
  on conflict(user_id) do update set password_hash=excluded.password_hash,updated_at=excluded.updated_at returning user_id;`;
const directory = mkdtempSync(join(tmpdir(), 'growth-harness-auth-reset-'));
try {
  const path = join(directory, 'reset.sql');
  writeFileSync(path, sql, { mode: 0o600 });
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', config.d1_databases[0].database_name,
    '--config', configPath, args.includes('--local') ? '--local' : '--remote', '--file', path, '--json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Password reset failed. Check the database target, migration 0081 and Cloudflare authorization. No credential output is shown.');
  // Remote --file uses D1 import: it prints upload progress even with --json and
  // does not return the INSERT's RETURNING rows. Read the credential back through
  // a separate query rather than replaying a reset whose import already succeeded.
  const verified = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', config.d1_databases[0].database_name,
    '--config', configPath, args.includes('--local') ? '--local' : '--remote', '--json', '--command',
    `select p.password_hash from auth_password_credentials p join app_users u on u.id=p.user_id join workspaces w on w.owner_user_id=u.id where w.id='primary-workspace' and u.email=${quote(email)}`], { encoding: 'utf8' });
  if (verified.status !== 0) throw new Error('Password import succeeded but verification failed. Inspect the existing administrator before attempting another reset.');
  const response = JSON.parse(verified.stdout);
  if (!response.some((entry: { results?: Array<{ password_hash?: string }> }) => entry.results?.some(row => row.password_hash === passwordHash))) throw new Error('Administrator credential could not be confirmed. No new account was created; inspect the existing administrator before resetting again.');
  console.log('Administrator password updated; existing sessions revoked. Enable password in AUTH_LOGIN_METHODS before logging in.');
} finally { rmSync(directory, { recursive: true, force: true }); }
