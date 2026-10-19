import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readWrangler } from './configuration.ts';
import { inspectConfiguration } from '../shared/config/index.ts';
import { inspectOwnerLoginAccess } from '../shared/config/auth.ts';

const args = process.argv.slice(2);
const configPath = args.includes('--config') ? resolve(args[args.indexOf('--config') + 1]) : resolve('wrangler.jsonc');
const config = readWrangler(configPath);
if (config.vars?.CLOUDFLARE_WORKER_NAME && config.vars.CLOUDFLARE_WORKER_NAME !== config.name) throw new Error('CLOUDFLARE_WORKER_NAME must match the Worker name in the selected Wrangler configuration.');
const databaseId = config.d1_databases?.[0]?.database_id || '';
if (!/^[a-f0-9-]{36}$/i.test(databaseId) || databaseId === '00000000-0000-0000-0000-000000000000') throw new Error('Set your own D1 database_id in wrangler.jsonc. The all-zero local placeholder cannot be deployed. Run npm run setup -- --cloudflare or provision it manually.');
// Deployment validation reads secret names only. Local .dev.vars never stands in for remote credentials.
const listed = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'list', '--config', configPath], { encoding: 'utf8' });
if (listed.status !== 0) throw new Error('Cannot inspect deployment secrets. Verify the Cloudflare account and Worker before deploying.');
let names: Array<{ name: string }>;
try { names = JSON.parse(listed.stdout); } catch { throw new Error('Cannot decode Cloudflare secret names. No secret values were requested.'); }
const report = inspectConfiguration({ ...config.vars, ...Object.fromEntries(names.map(item => [item.name, 'present-in-cloudflare-secrets'])) }, true);
if (report.errors.length) throw new Error(report.errors.map(issue => issue.message).join('\n'));
const sql = `select case when w.owner_user_id!='' then 1 else 0 end as initialized,
  exists(select 1 from auth_password_credentials p where p.user_id=w.owner_user_id) as password,
  exists(select 1 from app_users u where u.id=w.owner_user_id and u.google_sub not like 'local:%') as google
  from workspaces w where w.id='primary-workspace'`;
const inspected = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', config.d1_databases[0].database_name,
  '--config', configPath, '--remote', '--json', '--command', sql], { encoding: 'utf8' });
if (inspected.status !== 0) throw new Error('Cannot inspect administrator login availability. Apply required D1 migrations and verify the database target before deployment.');
const owner = JSON.parse(inspected.stdout)[0]?.results?.[0];
if (!owner) throw new Error('Primary workspace is not initialized. Apply D1 migrations before deployment.');
const loginError = inspectOwnerLoginAccess(report.loginMethods, { initialized: Boolean(owner.initialized), password: Boolean(owner.password), google: Boolean(owner.google) }, names.some(item => item.name === 'AUTH_SETUP_TOKEN'));
if (loginError) throw new Error(loginError);
console.log('Deployment configuration and existing administrator login availability checked. This does not verify provider access or migrate the database.');
