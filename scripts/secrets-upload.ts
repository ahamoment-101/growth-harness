import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readVars, readWrangler, secretsForDeployment } from './configuration.ts';

const vars = readVars(resolve('.dev.vars'));
const config = readWrangler();
const secrets = secretsForDeployment(config.vars || {}, vars);
// Bulk input goes over stdin, never process arguments, logs or a temporary plaintext file.
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk', '--config', 'wrangler.jsonc'], { input: JSON.stringify(secrets), stdio: ['pipe', 'inherit', 'inherit'] });
if (result.status !== 0) process.exit(result.status || 1);
console.log('Secret values uploaded. Non-secret settings such as AUTH_LOGIN_METHODS and OAuth client IDs belong in wrangler.jsonc vars for production.');
