import { resolve } from 'node:path';
import { localConfiguration } from './configuration.ts';
import { inspectConfiguration } from '../shared/config/index.ts';

const args = process.argv.slice(2);
const configPath = args.includes('--config') ? resolve(args[args.indexOf('--config') + 1]) : resolve('wrangler.jsonc');
try {
  const { env } = localConfiguration(configPath);
  const report = inspectConfiguration(env, args.includes('--require-models'));
  console.log(`Login methods: ${report.loginMethods.join(', ')}`);
  for (const issue of report.warnings) console.warn(`OPTIONAL: ${issue.message}`);
  for (const issue of report.errors) console.error(`ERROR: ${issue.message}`);
  if (report.errors.length) process.exitCode = 1;
  else console.log('Configuration check passed. This checks configuration presence and shape, not provider credentials or live service access.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration check failed');
  process.exitCode = 1;
}
