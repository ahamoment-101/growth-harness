import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWrangler } from './configuration.ts';
// @ts-ignore This module is also exercised directly by Node's test runner.
import { configuredD1Target, parseD1Options } from './d1-target.mjs';

const options = parseD1Options(process.argv.slice(2));
const target = configuredD1Target(readWrangler(options.configPath), options);
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), 'd1', 'migrations', 'apply', ...target], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
