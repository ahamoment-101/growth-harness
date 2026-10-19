import { existsSync, readFileSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';

const root = process.cwd();
const outputRoot = resolve(root, 'dist');

function localValues() {
  const source = resolve(root, '.dev.vars');
  if (!existsSync(source)) return [];
  // Documented public deployment settings may also be supplied locally. Their
  // presence in generated Wrangler vars is expected. Credentials remain scanned
  // even if someone accidentally copied them into a source configuration file.
  const publicKeys = new Set([
    'AUTH_LOGIN_METHODS', 'AUTH_ALLOWED_GOOGLE_EMAIL', 'AUTH_GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_ID', 'DATAFORSEO_LOGIN', 'MODEL_REGISTRY',
    'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKER_NAME', 'CNAME_TARGET', 'AI_GATEWAY_ACCOUNT_ID', 'AI_GATEWAY_NAME',
    'AGENT_RUNTIME_ENABLED', 'AGENT_RUNTIME_PROBE_ENABLED', 'DEV_TOOLS_ENABLED',
    'FIRECRAWL_RESEARCH_MODEL', 'FIRECRAWL_RESEARCH_MAX_CREDITS',
  ]);
  return Object.entries(parseEnv(readFileSync(source, 'utf8')))
    .filter(([key, value]) => !publicKeys.has(key) && value.length >= 8)
    .map(([key, value]) => ({ key, value }));
}

function filesUnder(directory) {
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (!entry) return [];
  if (entry.isSymbolicLink()) throw new Error('Build output must not contain symbolic links');
  if (entry.isFile()) return [directory];
  if (!entry.isDirectory()) throw new Error('Build output entries must be regular files or directories');
  return readdirSync(directory).flatMap(name => filesUnder(join(directory, name)));
}

// The Worker output directory follows the deployer's Worker name, not a fixed product name.
for (const file of filesUnder(outputRoot)) {
  if (basename(file) !== '.dev.vars') continue;
  if (!resolve(file).startsWith(`${outputRoot}${sep}`)) throw new Error('Refusing to sanitize outside the build output');
  unlinkSync(file);
  console.log('Removed Cloudflare preview-only environment file from the production build output');
}

const forbiddenNames = new Set(['.dev.vars', '.env']);
const values = localValues();
const leaks = [];
for (const file of filesUnder(outputRoot)) {
  const name = basename(file);
  if (forbiddenNames.has(name) || name.startsWith('.dev.vars.') || name.startsWith('.env.')) {
    leaks.push(`${file}: forbidden environment file`);
    continue;
  }
  const contents = readFileSync(file);
  for (const item of values) {
    if (contents.includes(Buffer.from(item.value))) {
      leaks.push(`${file}: contains value from ${item.key}`);
    }
  }
}

if (leaks.length) {
  throw new Error(`Build output contains local configuration values:\n${leaks.join('\n')}`);
}
console.log(`Build secret scan passed (${values.length} configured values checked)`);
