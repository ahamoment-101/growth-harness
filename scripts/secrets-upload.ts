import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readVars, readWrangler } from './configuration.ts';
import { inspectConfiguration } from '../shared/config/index.ts';
import { parseModelRegistry, selectedModelKeyNames } from '../shared/config/models.ts';

const vars = readVars(resolve('.dev.vars'));
const config = readWrangler();
const report = inspectConfiguration({ ...config.vars, ...vars }, true);
if (report.errors.length) throw new Error(report.errors.map(issue => issue.message).join('\n'));
const secretNames = ['AUTH_SETUP_TOKEN', 'AUTH_SESSION_SECRET', 'AUTH_GOOGLE_CLIENT_SECRET', ...selectedModelKeyNames(parseModelRegistry({ ...config.vars, ...vars })), 'FIRECRAWL_API_KEY', 'DATAFORSEO_PASSWORD', 'GOOGLE_CLIENT_SECRET', 'GSC_TOKEN_CIPHER_KEY', 'CLOUDFLARE_API_TOKEN', 'INDEXNOW_KEY'];
const secrets = Object.fromEntries(secretNames.filter(name => vars[name]).map(name => [name, vars[name]]));
// Bulk input goes over stdin, never process arguments, logs or a temporary plaintext file.
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk', '--config', 'wrangler.jsonc'], { input: JSON.stringify(secrets), stdio: ['pipe', 'inherit', 'inherit'] });
if (result.status !== 0) process.exit(result.status || 1);
console.log('Secret values uploaded. Non-secret settings such as AUTH_LOGIN_METHODS and OAuth client IDs belong in wrangler.jsonc vars for production.');
